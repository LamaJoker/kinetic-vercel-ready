-- 92 — Sécurité (011) : isolation entre comptes sur CHAQUE table, et anon fermé.
-- A et B sont deux utilisateurs ; les données de A sont créées en superuser.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;

-- ── Données de A (superuser) ──────────────────────────────────────────────
insert into public.profiles (id, email, full_name, avatar_url) values (:A, 'a@test.local', 'Alice', '')
  on conflict (id) do update set full_name = excluded.full_name;
insert into public.profiles (id, email, full_name, avatar_url) values (:B, 'b@test.local', 'Bob', '')
  on conflict (id) do nothing;
insert into public.entitlements (user_id) values (:A), (:B) on conflict (user_id) do nothing;
insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:xp', '1');
insert into public.daily_logs (user_id, date, xp_earned) values (:A, current_date, 10);
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/fcm/send/a-1', :A, 'BKey', 'auth');
insert into public.ai_coach_usage (user_id, prompt_chars) values (:A, 10);
insert into public.workout_sessions (id, user_id, name, started_at)
  values ('11111111-0000-0000-0000-000000000001', :A, 'Push', now());
insert into public.workout_sets (id, session_id, exercise_id, set_index, reps, weight_kg)
  values ('11111111-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'bench', 1, 5, 80);
insert into public.bodyweight_entries (user_id, date, weight_kg) values (:A, current_date, 80);
insert into public.weekly_goals (user_id) values (:A);

-- ── B ne lit ni ne modifie rien de A ──────────────────────────────────────
select t.login(:B);
set role authenticated;

select t.eq((select count(*) from public.user_storage where user_id = :A)::int, 0, 'user_storage : B ne lit pas A');
select t.eq((select count(*) from public.user_storage_delta where user_id = :A)::int, 0, 'user_storage_delta : B ne lit pas A');
select t.eq((select count(*) from public.user_storage_usage where user_id = :A)::int, 0, 'user_storage_usage : B ne lit pas A');
select t.eq((select count(*) from public.daily_logs where user_id = :A)::int, 0, 'daily_logs : B ne lit pas A');
select t.eq((select count(*) from public.user_stats where user_id = :A)::int, 0, 'user_stats : B ne lit pas A');
select t.eq((select count(*) from public.profiles where id = :A)::int, 0, 'profiles : B ne lit pas A');
select t.eq((select count(*) from public.entitlements where user_id = :A)::int, 0, 'entitlements : B ne lit pas le plan de A');
select t.eq((select count(*) from public.entitlements)::int, 1, 'entitlements : B ne voit que SON plan');
select t.eq((select count(*) from public.push_subscriptions where user_id = :A)::int, 0, 'push_subscriptions : B ne lit pas A');

with u as (update public.profiles set full_name = 'pirate' where id = :A returning 1)
select t.eq((select count(*) from u)::int, 0, 'profiles : UPDATE de B sur A : 0 ligne');
with u as (update public.push_subscriptions set user_agent = 'pirate' where user_id = :A returning 1)
select t.eq((select count(*) from u)::int, 0, 'push_subscriptions : UPDATE de B sur A : 0 ligne');
with d as (delete from public.push_subscriptions where user_id = :A returning 1)
select t.eq((select count(*) from d)::int, 0, 'push_subscriptions : DELETE de B sur A : 0 ligne');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/fcm/send/b-as-a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'k', 'a')$$,
  '42501', 'push_subscriptions : B ne crée pas d''abonnement au nom de A');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/fcm/send/a-1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')
  on conflict (endpoint) do update set user_id = excluded.user_id$$,
  '42501', 'push_subscriptions : B ne détourne pas l''endpoint de A (upsert)');

-- Tables internes et mortes : aucun accès, même à ses propres lignes.
select t.throws($$select 1 from public.ai_coach_usage$$, '42501', 'ai_coach_usage : illisible par les clients');
select t.throws($$insert into public.ai_coach_usage (user_id) values ('bbbbbbbb-0000-0000-0000-00000000000b')$$,
  '42501', 'ai_coach_usage : un client ne s''ajoute pas de crédit ni de ligne');
select t.throws($$delete from public.ai_coach_usage$$, '42501', 'ai_coach_usage : un client ne remet pas son quota à zéro');
select t.throws($$truncate public.ai_coach_usage$$, '42501', 'ai_coach_usage : TRUNCATE refusé');
select t.throws($$update public.ai_coach_limits set hourly_per_user = 1000$$, '42501', 'ai_coach_limits : non modifiable');
select t.throws($$delete from public.ai_coach_daily_global$$, '42501', 'ai_coach_daily_global : non modifiable');
select t.throws($$delete from public.rate_limits$$, '42501', 'rate_limits : non modifiable');
select t.throws($$select 1 from public.workout_sessions$$, '42501', 'workout_sessions (morte) : fermée');
select t.throws($$insert into public.workout_sessions (id, user_id, name, started_at)
  values (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-00000000000b', repeat('z', 100000), now())$$,
  '42501', 'workout_sessions (morte) : plus d''écriture de 100 Ko hors quota');
select t.throws($$select 1 from public.workout_sets$$, '42501', 'workout_sets (morte) : fermée');
select t.throws($$select 1 from public.bodyweight_entries$$, '42501', 'bodyweight_entries (morte) : fermée');
select t.throws($$select 1 from public.weekly_goals$$, '42501', 'weekly_goals (morte) : fermée');
select t.throws($$insert into public.vitals_metrics (name, value, rating) values ('LCP', 1, 'good')$$,
  '42501', 'vitals_metrics (morte) : fermée');
select t.throws($$delete from public.vitals_rate_limit$$, '42501', 'vitals_rate_limit : fermée (SEC-03)');

-- daily_logs : plus d'écriture directe (bornes de upsert_daily_log non contournables, SEC-04).
select t.throws($$insert into public.daily_logs (user_id, date, xp_earned, metadata)
  values ('bbbbbbbb-0000-0000-0000-00000000000b', '1900-01-01', 2000000000, '{}')$$,
  '42501', 'daily_logs : INSERT direct refusé');
select t.throws($$update public.daily_logs set xp_earned = 2000000000$$, '42501', 'daily_logs : UPDATE direct refusé');
select t.throws($$delete from public.daily_logs$$, '42501', 'daily_logs : DELETE refusé');

-- ── Pro : un client ne peut pas s'octroyer Pro ────────────────────────────
select t.throws($$update public.entitlements set tier = 'pro', pro_until = null$$, '42501', 'Pro : UPDATE de son plan refusé');
select t.throws($$update public.entitlements set trial_ends_at = now() + interval '100 years'$$, '42501',
  'Pro : prolonger son essai refusé');
select t.throws($$insert into public.entitlements (user_id, tier) values ('bbbbbbbb-0000-0000-0000-00000000000b', 'pro')
  on conflict (user_id) do update set tier = 'pro'$$, '42501', 'Pro : upsert de son plan refusé');
select t.throws($$delete from public.entitlements$$, '42501', 'Pro : suppression de son plan refusée');
select t.throws($$select public.is_pro('bbbbbbbb-0000-0000-0000-00000000000b')$$, '42501', 'is_pro : réservé au service_role');
select t.eq((select tier from public.entitlements), 'free', 'B reste free');

-- ── profiles : seuls full_name et avatar_url (https) sont modifiables ─────
with u as (update public.profiles set full_name = 'Bob B.' where id = :B returning 1)
select t.eq((select count(*) from u)::int, 1, 'profiles : B modifie son nom');
select t.throws($$update public.profiles set email = 'admin@kinetic.app'$$, '42501', 'profiles : email non modifiable');
select t.throws($$update public.profiles set id = 'aaaaaaaa-0000-0000-0000-00000000000a'$$, '42501', 'profiles : id non modifiable');
select t.throws($$update public.profiles set avatar_url = 'javascript:alert(1)'$$, '23514', 'profiles : avatar non https refusé (CHECK)');
with u as (update public.profiles set avatar_url = 'https://cdn.example.com/a.png' returning 1)
select t.eq((select count(*) from u)::int, 1, 'profiles : avatar https accepté');
select t.throws($$update public.profiles set full_name = repeat('x', 101)$$, '23514', 'profiles : nom > 100 caractères refusé (CHECK)');
select t.throws($$insert into public.profiles (id) values ('bbbbbbbb-0000-0000-0000-00000000000c')$$, '42501',
  'profiles : INSERT client refusé');
select t.throws($$delete from public.profiles$$, '42501', 'profiles : DELETE client refusé');

-- ── push_subscriptions : endpoint https sur un service push connu (SEC-06) ─
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
values ('https://fcm.googleapis.com/fcm/send/b-1', :B, 'BNcRd-key_1=', 'tBHI-auth');
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
values ('https://updates.push.services.mozilla.com/wpush/v2/gAAAA', :B, 'k', 'a');
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
values ('https://web.push.apple.com/QGuQyavXutnMH', :B, 'k', 'a');
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
values ('https://wns2-par02p.notify.windows.com/w/?token=AQE%3d', :B, 'k', 'a');
select t.eq((select count(*) from public.push_subscriptions)::int, 4, 'push : FCM, Mozilla, Apple, Windows acceptés');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('http://169.254.169.254/latest/meta-data', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : SSRF métadonnées cloud (http) refusée');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://evil.example.com/hook', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : domaine inconnu refusé');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com@evil.example.com/x', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : userinfo « fcm.googleapis.com@evil » refusé');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com.evil.example.com/x', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : suffixe de domaine trompeur refusé');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com:8443/x', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : port explicite refusé');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/' || repeat('a', 1000), 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  '23514', 'push : endpoint > 1000 caractères refusé');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/x2', 'bbbbbbbb-0000-0000-0000-00000000000b', repeat('k', 201), 'a')$$,
  '23514', 'push : clé p256dh > 200 caractères refusée');
select t.throws($$update public.push_subscriptions set endpoint = 'http://127.0.0.1/'$$,
  '23514', 'push : UPDATE vers un endpoint interdit refusé');
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
select 'https://fcm.googleapis.com/fcm/send/b-cap-' || g, :B, 'k', 'a' from generate_series(1, 6) g;
select t.eq((select count(*) from public.push_subscriptions)::int, 10, 'push : 10 abonnements autorisés');
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/fcm/send/b-11', 'bbbbbbbb-0000-0000-0000-00000000000b', 'k', 'a')$$,
  'P0001', 'push : 11e abonnement refusé (plafond 10)');

-- ── anon : aucune table lisible ni modifiable, aucune fonction sensible ───
reset role;
select t.login(null);
set role anon;
select t.throws(format('select 1 from %s limit 1', c.oid::regclass), '42501',
                'anon : SELECT refusé sur ' || c.relname)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
order by c.relname;
select t.throws(format('delete from %s', c.oid::regclass), '42501', 'anon : DELETE refusé sur ' || c.relname)
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by c.relname;
select t.throws($$select public.upsert_daily_log(current_date, 1, 1, 1, null)$$, '42501', 'anon : upsert_daily_log refusé');
select t.throws($$select * from public.get_changes_since('1970-01-01')$$, '42501', 'anon : get_changes_since refusé (SEC-12)');
select t.throws($$select public.consume_ai_quota('aaaaaaaa-0000-0000-0000-00000000000a')$$, '42501', 'anon : consume_ai_quota refusé');
select t.throws($$select public.consume_rate_limit('x', 'y', 1, 60)$$, '42501', 'anon : consume_rate_limit refusé');
select t.throws($$select public.purge_security_counters()$$, '42501', 'anon : purge refusée');
select t.ok(public.keep_alive() like 'ok:%', 'anon : keep_alive reste disponible (workflow keep-alive)');
reset role;

-- ── A n'a rien perdu ──────────────────────────────────────────────────────
select t.eq((select full_name from public.profiles where id = :A), 'Alice', 'profil de A intact');
select t.eq((select count(*) from public.push_subscriptions where user_id = :A)::int, 1, 'abonnement de A intact');
select t.eq((select count(*) from public.ai_coach_usage where user_id = :A)::int, 1, 'usage IA de A intact');
select t.eq((select tier from public.entitlements where user_id = :B), 'free', 'B toujours free (vérifié en superuser)');
rollback;
