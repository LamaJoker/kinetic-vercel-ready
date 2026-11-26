-- 87 — Compatibilité production (revue « compatibilité et production » de 011).
-- Parcours complet d'un utilisateur réel avec les rôles tels qu'ils existent sur
-- Supabase, et non en superuser :
--   - inscription et suppression de compte par supabase_auth_admin (GoTrue), rôle
--     SANS superuser ni BYPASSRLS et sans aucun droit sur public ;
--   - chaque appel .rpc( / .from( de packages/adapter-web, en rôle authenticated ;
--   - anciens clients encore installés (push web d'avant 9.3.0 : upsert onConflict
--     endpoint, lecture d'entitlements) ;
--   - quotas IA écrits par le service_role puis effacés avec le compte.
\set C '''96969696-0000-0000-0000-000000000096'''
begin;

-- ── Rôle GoTrue tel que sur Supabase (créé dans la transaction, annulé à la fin) ─
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;
grant usage on schema auth to supabase_auth_admin;
grant select, insert, update, delete on auth.users to supabase_auth_admin;

-- ── Inscription (GoTrue insère dans auth.users) ─────────────────────────────
set role supabase_auth_admin;
insert into auth.users (id, email, raw_user_meta_data)
values (:C, 'c@test.local',
        jsonb_build_object('full_name', repeat('é', 300) || E'\u0001',
                           'avatar_url', 'javascript:alert(1)'));
reset role;
select t.eq((select char_length(full_name) from public.profiles where id = :C), 100,
  'inscription GoTrue : profil créé, nom borné à 100 caractères');
select t.eq((select avatar_url from public.profiles where id = :C), '',
  'inscription GoTrue : avatar non https remplacé par une chaîne vide');
select t.ok(exists (select 1 from public.entitlements where user_id = :C),
  'inscription GoTrue : ligne entitlements créée');

-- ── Parcours de l'application web (rôle authenticated) ──────────────────────
select t.login(:C);
set role authenticated;

-- SupabaseSyncRemote : sync_push, sync_pull_v2, sync_pull, sync_usage.
select t.eq(t.item(public.sync_push('[{"key":"kinetic:xp","value":42}]'::jsonb), 'kinetic:xp') ->> 'status',
  'ok', 'sync_push : accessible et appliqué');
select t.ok(jsonb_array_length(public.sync_pull_v2(null) -> 'changes') >= 1, 'sync_pull_v2 : accessible');
select t.ok((select count(*) from public.sync_pull('1970-01-01', '', 500)) >= 1, 'sync_pull (ancien client) : accessible');
select t.ok((public.sync_usage() ->> 'keys')::int >= 1, 'sync_usage : accessible');
-- SupabaseStorage : upsert / select / delete directs sur user_storage.
insert into public.user_storage (user_id, key, value) values (:C, 'kinetic:legacy', '1')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select value from public.user_storage where user_id = :C and key = 'kinetic:legacy'), '1'::jsonb,
  'SupabaseStorage.set/get : accessibles');
delete from public.user_storage where user_id = :C and key = 'kinetic:legacy';
select t.ok((select deleted from public.user_storage where user_id = :C and key = 'kinetic:legacy'),
  'SupabaseStorage.remove : tombstone');
-- Anciens RPC / vue.
select t.ok((select count(*) from public.get_changes_since('1970-01-01')) >= 1, 'get_changes_since : accessible');
select t.ok((select count(*) from public.user_storage_delta) >= 1, 'user_storage_delta : accessible');
-- SupabaseDailyLogSync : upsert_daily_log sans metadata (forme réelle du client).
select public.upsert_daily_log(current_date, 120, 3, 5, null);
select public.upsert_daily_log(current_date, 80, 4, 5, null);
select t.eq((select (xp_earned, tasks_done) from public.daily_logs where user_id = :C and date = current_date),
  (120, 4), 'upsert_daily_log : accessible, maxima conservés');
select t.ok((select count(*) from public.user_stats) = 1, 'user_stats : lisible (sa ligne)');
-- Profil : mise à jour du nom alors que avatar_url = '' (refusée avant 011).
update public.profiles set full_name = 'Camille' where id = :C;
select t.eq((select full_name from public.profiles where id = :C), 'Camille', 'profil sans avatar : mise à jour possible');
-- Ancien client (avant 9.3.0) : lecture de son plan.
select t.eq((select tier from public.entitlements where user_id = :C), 'free', 'entitlements : lisible');

-- Ancien client push (avant 9.3.0) : upsert onConflict endpoint, avec updated_at.
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, updated_at)
select 'https://fcm.googleapis.com/fcm/send/dev' || i, :C, 'BPk' || i, 'au' || i, 'UA', now()
from generate_series(1, 10) i;
select t.eq((select count(*) from public.push_subscriptions where user_id = :C)::int, 10, 'push : 10 abonnements');
-- Le navigateur ré-enregistre un abonnement EXISTANT (rafraîchissement des clés) :
-- ce n'est pas un 11e abonnement, l'upsert doit passer.
insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, updated_at)
values ('https://fcm.googleapis.com/fcm/send/dev3', :C, 'BPkNEW', 'auNEW', 'UA', now())
on conflict (endpoint) do update
  set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
      updated_at = excluded.updated_at;
select t.eq((select p256dh from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/dev3'),
  'BPkNEW', 'push : upsert d''un abonnement existant accepté au plafond');
-- Un vrai 11e abonnement reste refusé.
select t.throws($$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values ('https://fcm.googleapis.com/fcm/send/dev11', '96969696-0000-0000-0000-000000000096', 'k', 'a')
  on conflict (endpoint) do update set p256dh = excluded.p256dh$$,
  'P0001', 'push : 11e abonnement (upsert) toujours refusé');
reset role;

-- ── Fonctions Edge (service_role) : quota IA et limiteur ────────────────────
set role service_role;
select t.ok((public.consume_ai_quota(:C, 100) ->> 'allowed')::boolean, 'consume_ai_quota : service_role');
select t.ok((public.consume_rate_limit('delete_account', replace(:C, '-', ''), 5, 3600) ->> 'allowed')::boolean,
  'consume_rate_limit : service_role');
reset role;

-- ── Suppression de compte (delete-account → auth.admin.deleteUser) ──────────
set role supabase_auth_admin;
delete from auth.users where id = :C;
reset role;
select t.eq((
  select count(*) from (
    select user_id from public.user_storage where user_id = :C
    union all select user_id from public.user_storage_usage where user_id = :C
    union all select id from public.profiles where id = :C
    union all select user_id from public.entitlements where user_id = :C
    union all select user_id from public.daily_logs where user_id = :C
    union all select user_id from public.push_subscriptions where user_id = :C
    union all select user_id from public.ai_coach_usage where user_id = :C
  ) s)::int, 0, 'suppression par GoTrue (sans BYPASSRLS) : toutes les données du compte effacées');

rollback;
