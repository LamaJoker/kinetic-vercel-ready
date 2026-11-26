-- 70 — Purge des tombstones, horizon et resync_required.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
begin;
select t.login(:A);
set role authenticated;
select public.sync_push('[
  {"key":"g:old","value":1,"base":null},
  {"key":"g:recent","value":2,"base":null},
  {"key":"g:alive","value":3,"base":null}
]');
select public.sync_push((select jsonb_agg(jsonb_build_object('key', key, 'deleted', true, 'base', updated_at))
  from public.user_storage where key in ('g:old', 'g:recent')));
reset role;

-- Vieillissement artificiel (superuser, triggers désactivés) : g:old supprimée il y a 200 jours.
set session_replication_role = replica;
update public.user_storage set updated_at = now() - interval '200 days', deleted_at = now() - interval '200 days'
where user_id = :A and key = 'g:old';
update public.user_storage set updated_at = now() - interval '300 days'
where user_id = :A and key = 'g:alive';
set session_replication_role = origin;

select t.throws($$select public.purge_sync_tombstones(interval '1 hour')$$, '22023', 'older_than < 1 jour refusé');

set role service_role;
select t.eq(public.purge_sync_tombstones(), 1::bigint, 'purge (180 jours) : 1 tombstone supprimée');
reset role;
select t.ok(not exists (select 1 from public.user_storage where key = 'g:old'), 'g:old purgée');
select t.ok(exists (select 1 from public.user_storage where key = 'g:recent' and deleted), 'tombstone récente conservée');
select t.ok(exists (select 1 from public.user_storage where key = 'g:alive' and not deleted), 'ligne vivante ancienne conservée');
select t.ok((select tombstone_horizon from public.sync_meta) between now() - interval '180 days 1 minute'
  and now() - interval '179 days 23 hours', 'horizon enregistré à now() − 180 jours');
select t.eq((select last_purge_count from public.sync_meta), 1::bigint, 'last_purge_count');
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)),
  'purge : compteur de quota inchangé et exact');

-- Horizon monotone : une purge plus courte ne le fait pas reculer... ni une plus longue.
create temp table h as select tombstone_horizon from public.sync_meta;
grant select on h to public;
set role service_role;
select public.purge_sync_tombstones(interval '365 days');
reset role;
select t.eq((select tombstone_horizon from public.sync_meta), (select tombstone_horizon from h), 'horizon : ne recule jamais');

select t.login(:A);
set role authenticated;
select t.eq(public.sync_pull_v2(now() - interval '200 days') -> 'resync_required', 'true'::jsonb,
  'curseur antérieur à l''horizon : resync_required');
select t.eq(public.sync_pull_v2(now() - interval '200 days') ->> 'reason', 'tombstones_purged', 'raison : tombstones_purged');
select t.eq(jsonb_array_length(public.sync_pull_v2(now() - interval '200 days') -> 'changes'), 0,
  'resync_required : aucun changement partiel renvoyé');
select t.eq(public.sync_pull_v2(now() - interval '10 days') -> 'resync_required', 'false'::jsonb,
  'curseur postérieur à l''horizon : pas de resync');
select t.eq(public.sync_pull_v2(null) -> 'resync_required', 'false'::jsonb, 'pull complet (null) : jamais de resync');
select t.eq(public.sync_pull_v2('1970-01-01T00:00:00Z') -> 'resync_required', 'false'::jsonb,
  'pull complet (epoch) : jamais de resync');
select t.ok((public.sync_pull_v2(null) ->> 'horizon')::timestamptz = (select tombstone_horizon from h),
  'le pull expose l''horizon');
-- Ancienne RPC : inchangée (pas de notion d'horizon).
select t.ok((select count(*) from public.sync_pull(now() - interval '400 days', '', 500)) >= 1,
  'ancienne sync_pull : fonctionne toujours');
-- Après purge, pousser une clé purgée avec une vieille base : créée (pas de conflit, rien à perdre).
select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'g:old', 'value', 9,
  'base', now() - interval '250 days'))) -> 0 ->> 'status', 'ok', 'écriture sur clé purgée : ok (création)');
reset role;
rollback;
