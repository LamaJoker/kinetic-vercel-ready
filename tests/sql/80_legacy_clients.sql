-- 80 — Compatibilité des clients déjà installés (SupabaseStorage d'avant 010) :
-- upsert direct, DELETE, clear, get, ancienne sync_pull, RPC/vue legacy, suppression de compte.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;
select t.login(:A);
set role authenticated;

-- SupabaseStorage.set : upsert onConflict user_id,key (sans deleted ni updated_at).
insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:training:session:s1', '{"id":"s1"}')
on conflict (user_id, key) do update set value = excluded.value;
insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:xp', '10')
on conflict (user_id, key) do update set value = excluded.value;
insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:xp', '20')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select value from public.user_storage where key = 'kinetic:xp'), '20'::jsonb, 'upsert direct : fonctionne');
select t.ok((select updated_at from public.user_storage where key = 'kinetic:xp') <= clock_timestamp(), 'upsert direct : version serveur');

-- SupabaseStorage.remove : DELETE → tombstone (propagée aux nouveaux clients).
create temp table before_del as select updated_at from public.user_storage where key = 'kinetic:training:session:s1';
delete from public.user_storage where user_id = :A and key = 'kinetic:training:session:s1';
select t.eq((select (deleted, value) from public.user_storage where key = 'kinetic:training:session:s1'),
  (true, 'null'::jsonb), 'DELETE client : ligne conservée en tombstone');
select t.ok((select updated_at from public.user_storage where key = 'kinetic:training:session:s1') > (select updated_at from before_del),
  'DELETE client : nouvelle version (le pull des autres appareils la voit)');
select t.ok(exists (select 1 from jsonb_array_elements(public.sync_pull_v2(null) -> 'changes') e
  where e ->> 'key' = 'kinetic:training:session:s1' and (e -> 'deleted')::boolean), 'sync_pull_v2 transmet la suppression');
select t.ok(not exists (select 1 from public.sync_pull('1970-01-01', '', 500) where key = 'kinetic:training:session:s1'),
  'ancienne sync_pull : la clé supprimée n''apparaît plus');
-- SupabaseStorage.get sur une tombstone : value = JSON null → interprété « absent » par l'ancien client.
select t.eq((select value from public.user_storage where user_id = :A and key = 'kinetic:training:session:s1'),
  'null'::jsonb, 'ancien get() sur tombstone : null (absent)');
-- DELETE répété : sans effet, pas d'erreur.
delete from public.user_storage where user_id = :A and key = 'kinetic:training:session:s1';
select t.ok((select deleted from public.user_storage where key = 'kinetic:training:session:s1'), 'DELETE répété : reste tombstone');

-- Ancien client qui ré-écrit la clé supprimée (upsert direct sans colonne deleted) : recréation.
insert into public.user_storage (user_id, key, value) values (:A, 'kinetic:training:session:s1', '{"id":"s1","v":2}')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select (deleted, value) from public.user_storage where key = 'kinetic:training:session:s1'),
  (false, '{"id":"s1","v":2}'::jsonb), 'upsert ancien client sur tombstone : clé recréée vivante');

-- SupabaseStorage.clear : DELETE de toutes les lignes → toutes en tombstone.
delete from public.user_storage where user_id = :A;
select t.eq((select count(*) from public.user_storage where user_id = :A and not deleted)::int, 0, 'clear() ancien client : tout en tombstone');
select t.eq((select count(*) from public.user_storage where user_id = :A and deleted)::int, 2, 'clear() : 2 tombstones');

-- RPC et vue legacy : pas de tombstone.
select t.eq((select count(*) from public.get_changes_since('1970-01-01'))::int, 0, 'get_changes_since : tombstones masquées');
select t.eq((select count(*) from public.user_storage_delta)::int, 0, 'vue user_storage_delta : tombstones masquées');

-- Ancien keys() (select key) : voit les tombstones, mais uniquement en mode legacy (sync_pull absente) — documenté.

-- Suppression de compte (Edge Function delete-account → auth.admin.deleteUser → cascade) :
-- suppression PHYSIQUE de toutes les lignes et du compteur, pas de tombstone bloquante.
reset role;
select t.login(null);
select t.eq((select count(*) from public.user_storage where user_id = :A)::int, 2, 'avant suppression de compte : 2 lignes');
delete from auth.users where id = :A;
select t.eq((select count(*) from public.user_storage where user_id = :A)::int, 0, 'suppression de compte : lignes effacées physiquement');
select t.eq((select count(*) from public.user_storage_usage where user_id = :A)::int, 0, 'suppression de compte : compteur effacé');
rollback;
