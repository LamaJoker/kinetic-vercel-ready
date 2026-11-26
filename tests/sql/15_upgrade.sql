-- 15 — Montée de version : données écrites par un ancien client avant 010.
\set C '''cccccccc-0000-0000-0000-00000000000c'''
begin;

select t.eq((select count(*) from public.user_storage where user_id = :C)::int, 4,
  'aucune ligne perdue par la migration');
select t.eq((select count(*) from public.user_storage where user_id = :C and deleted)::int, 0,
  'les lignes existantes restent vivantes (deleted = false)');
select t.ok((select updated_at from public.user_storage where user_id = :C and key = 'kinetic:future')
  < now() + interval '1 minute', 'version future (2099) ramenée à l''heure serveur');
select t.ok((select max(updated_at) from public.user_storage where user_id = :C) < now() + interval '1 minute',
  'plus aucune version dans le futur');
select t.eq((select (keys, bytes) from t.actual_usage(:C)), (select (keys, bytes) from t.expected_usage(:C)),
  'compteur de quota initialisé exactement depuis l''existant');
select t.eq((select keys from t.actual_usage(:C)), 4, 'compteur : 4 clés');
select t.ok((select last_version from public.user_storage_usage where user_id = :C)
  >= (select max(updated_at) from public.user_storage where user_id = :C), 'last_version initialisée');

-- Index : plus de INCLUDE(value) ni de doublon ; index du pull et des tombstones présents.
select t.ok(to_regclass('public.idx_user_storage_user_key') is null, 'idx_user_storage_user_key supprimé');
select t.ok(to_regclass('public.idx_user_storage_updated') is null, 'idx_user_storage_updated supprimé');
select t.ok(to_regclass('public.idx_user_storage_user_updated_key') is not null, 'index keyset du pull présent');
select t.ok(to_regclass('public.idx_user_storage_tombstones') is not null, 'index partiel des tombstones présent');
select t.ok((select convalidated from pg_constraint where conname = 'user_storage_tombstone_shape'),
  'contrainte de forme des tombstones validée');

-- Anciens triggers remplacés.
select t.ok(not exists (select 1 from pg_trigger where tgrelid = 'public.user_storage'::regclass
  and tgname in ('user_storage_updated_at', 'enforce_storage_quota')), 'anciens triggers retirés');
-- Les trois triggers de 010, plus celui de 011 (refus d'une écriture pour un autre
-- utilisateur avant tout code SECURITY DEFINER) : ensemble exact, déclenché dans cet ordre.
select t.eq((select string_agg(tgname, ',' order by tgname) from pg_trigger
  where tgrelid = 'public.user_storage'::regclass
  and tgname like 'user_storage\_%\_%' and not tgisinternal),
  'user_storage_01_owner_check,user_storage_05_delete_as_tombstone,user_storage_10_before_write,user_storage_90_after_write',
  'nouveaux triggers (010 + 011), ensemble exact');

-- Droits : rien d'interne n'est exécutable par les clients (droits par défaut Supabase révoqués).
select t.ok(not has_function_privilege('authenticated', 'public.user_storage_lock_user(uuid)', 'execute'),
  'user_storage_lock_user non exécutable par authenticated');
select t.ok(not has_function_privilege('authenticated', 'public.purge_sync_tombstones(interval)', 'execute'),
  'purge non exécutable par authenticated');
select t.ok(has_function_privilege('service_role', 'public.purge_sync_tombstones(interval)', 'execute'),
  'purge exécutable par service_role');
select t.ok(not has_function_privilege('anon', 'public.sync_push(jsonb)', 'execute'), 'sync_push fermé à anon');
select t.ok(has_function_privilege('authenticated', 'public.sync_push(jsonb)', 'execute'), 'sync_push ouvert à authenticated');
select t.ok(not has_table_privilege('authenticated', 'public.user_storage_usage', 'insert'), 'compteur non modifiable');
select t.ok(not has_table_privilege('anon', 'public.sync_meta', 'select'), 'sync_meta fermé à anon');
rollback;
