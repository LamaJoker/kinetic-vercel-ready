-- 93 — Sécurité (011) : pas de contournement de la RLS par une fonction SECURITY
-- DEFINER, search_path non détournable, métadonnées d'inscription bornées.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;

insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:secret', '"a"');

-- ── upsert_daily_log : écrit toujours pour auth.uid(), jamais pour un tiers ─
select t.login(:B);
set role authenticated;
select public.upsert_daily_log(current_date, 50, 2, 3, '{"src":"test"}');
reset role;
select t.eq((select count(*) from public.daily_logs where user_id = :B)::int, 1, 'upsert_daily_log : ligne créée pour l''appelant');
select t.eq((select count(*) from public.daily_logs where user_id = :A)::int, 0, 'upsert_daily_log : aucune ligne pour un tiers');
select t.login(:B);
set role authenticated;
select t.throws($$select public.upsert_daily_log(current_date, 1, 1, 1, jsonb_build_object('x', repeat('z', 5000)))$$,
  'P0001', 'upsert_daily_log : metadata > 4 Ko refusée (SEC-04)');
select t.throws($$select public.upsert_daily_log(current_date, 1, 1, 1, '[1,2,3]')$$,
  'P0001', 'upsert_daily_log : metadata non objet refusée');
select t.throws($$select public.upsert_daily_log('1900-01-01', 1, 1, 1, null)$$, 'P0001', 'upsert_daily_log : date hors fenêtre refusée');
select t.throws($$select public.upsert_daily_log(current_date, 2000000000, 1, 1, null)$$, 'P0001', 'upsert_daily_log : xp hors borne refusé');
select t.throws($$select public.upsert_daily_log(null, 1, 1, 1, null)$$, '22023', 'upsert_daily_log : paramètre null refusé');
select t.eq((select xp_earned from public.daily_logs), 50, 'upsert_daily_log : rien d''écrit par les appels refusés');
reset role;
select t.login(null);
set role authenticated;
select t.throws($$select public.upsert_daily_log(current_date, 1, 1, 1, null)$$, '42501',
  'upsert_daily_log : JWT sans sub refusé explicitement');
reset role;

-- ── get_changes_since (ancien RPC) : SECURITY INVOKER, RLS appliquée ───────
select t.ok(not (select prosecdef from pg_proc where oid = 'public.get_changes_since(timestamptz)'::regprocedure),
  'get_changes_since n''est plus SECURITY DEFINER');
select t.ok(not (select prosecdef from pg_proc where oid = 'public.set_updated_at()'::regprocedure),
  'set_updated_at n''est plus SECURITY DEFINER');
select t.login(:B);
set role authenticated;
select t.eq((select count(*) from public.get_changes_since('1970-01-01'))::int, 0, 'get_changes_since : B ne voit pas A');
reset role;

-- ── search_path : un client ne peut pas glisser d'objet homonyme ──────────
select t.login(:B);
set role authenticated;
select t.throws($$create function public.auth_uid() returns uuid language sql as 'select null::uuid'$$,
  '42501', 'authenticated ne crée pas de fonction dans public');
select t.throws($$create table public.user_storage_shadow (x int)$$, '42501', 'authenticated ne crée pas de table dans public');
-- Une table temporaire homonyme ne détourne ni sync_usage ni get_changes_since
-- (pg_temp en dernier ou absent, noms qualifiés).
create temp table user_storage (user_id uuid, key text, value jsonb, updated_at timestamptz, deleted boolean);
insert into pg_temp.user_storage values (:A, 'kinetic:fake', '"x"', now(), false);
create temp table user_storage_usage (user_id uuid, keys int, bytes bigint);
insert into pg_temp.user_storage_usage values (:B, 999999, 999999);
select t.eq((select count(*) from public.get_changes_since('1970-01-01'))::int, 0, 'table temporaire homonyme ignorée (get_changes_since)');
select t.eq((public.sync_usage() ->> 'keys')::int, 0, 'table temporaire homonyme ignorée (sync_usage)');
select t.eq(t.item(public.sync_push('[{"key":"kinetic:ok","value":1,"base":null}]'), 'kinetic:ok') ->> 'status', 'ok',
  'sync_push écrit dans la vraie table malgré la table temporaire');
reset role;
select t.eq((select count(*) from public.user_storage where user_id = :B and key = 'kinetic:ok')::int, 1,
  'écriture constatée dans public.user_storage');
select t.eq((select keys from public.user_storage_usage where user_id = :B), 1, 'compteur réel non falsifié');

-- ── Fonctions réservées au service_role : refusées aux clients ────────────
select t.login(:B);
set role authenticated;
select t.throws($$select public.consume_ai_quota('bbbbbbbb-0000-0000-0000-00000000000b')$$, '42501',
  'authenticated : consume_ai_quota refusé (même pour soi)');
select t.throws($$select public.consume_ai_coach_quota('aaaaaaaa-0000-0000-0000-00000000000a', 1000, 0)$$, '42501',
  'authenticated : consume_ai_coach_quota refusé');
select t.throws($$select public.consume_rate_limit('report_error_ip', 'abc', 1000000, 1)$$, '42501',
  'authenticated : consume_rate_limit refusé');
select t.throws($$select public.purge_security_counters()$$, '42501', 'authenticated : purge des compteurs refusée');
select t.throws($$select public.user_storage_lock_user('aaaaaaaa-0000-0000-0000-00000000000a')$$, '42501',
  'authenticated : verrou d''un autre compte refusé');
reset role;

-- ── Pro : seul le service_role l'accorde ; is_pro le reflète ──────────────
set role service_role;
update public.entitlements set tier = 'pro', pro_until = now() + interval '1 month', trial_ends_at = null
where user_id = :B;
select t.ok(public.is_pro(:B), 'service_role accorde Pro : is_pro vrai');
update public.entitlements set tier = 'free', pro_until = null, trial_ends_at = now() - interval '1 day'
where user_id = :A;
select t.ok(not public.is_pro(:A), 'essai expiré : is_pro faux');
reset role;
select t.ok((select updated_at from public.entitlements where user_id = :B) = now(),
  'trigger set_updated_at (SECURITY INVOKER) toujours actif');
select t.login(:B);
set role authenticated;
select t.eq((select tier from public.entitlements), 'pro', 'B lit son plan Pro');
reset role;

-- ── Inscription : métadonnées bornées (handle_new_user, SEC-12) ───────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-00000000000e', 'e@test.local',
   jsonb_build_object('full_name', E'Eve\u0007' || repeat('x', 500), 'avatar_url', 'javascript:alert(1)')),
  ('ffffffff-0000-0000-0000-00000000000f', 'f@test.local',
   jsonb_build_object('full_name', 'Fred', 'avatar_url', 'https://cdn.example.com/f.png'));
select t.eq((select char_length(full_name) from public.profiles where id = 'eeeeeeee-0000-0000-0000-00000000000e'), 100,
  'inscription : nom tronqué à 100 caractères');
select t.ok((select full_name !~ '[[:cntrl:]]' from public.profiles where id = 'eeeeeeee-0000-0000-0000-00000000000e'),
  'inscription : caractères de contrôle retirés');
select t.eq((select avatar_url from public.profiles where id = 'eeeeeeee-0000-0000-0000-00000000000e'), '',
  'inscription : avatar non https ignoré');
select t.eq((select avatar_url from public.profiles where id = 'ffffffff-0000-0000-0000-00000000000f'),
  'https://cdn.example.com/f.png', 'inscription : avatar https conservé');
select t.eq((select tier from public.entitlements where user_id = 'ffffffff-0000-0000-0000-00000000000f'), 'free',
  'inscription : plan free créé (essai), jamais Pro');

-- ── Vitals (SEC-09) : le trigger ne dépend plus de pgcrypto ───────────────
select set_config('request.headers', '{"x-forwarded-for":"203.0.113.7"}', true);
set role service_role;
insert into public.vitals_metrics (name, value, rating) values ('LCP', 1.2, 'good');
reset role;
select t.eq((select ip_hash from public.vitals_rate_limit where ip_hash <> 'unknown'),
  encode(sha256(convert_to('203.0.113.7', 'UTF8')), 'hex'), 'check_vitals_rate_limit fonctionne (sha256 natif, SEC-09)');
select t.ok(not exists (select 1 from pg_proc where oid = 'public.check_vitals_rate_limit()'::regprocedure
                        and prosrc ~ '\mdigest\('), 'check_vitals_rate_limit n''appelle plus digest()');
rollback;
