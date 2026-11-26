-- 10 — Isolation RLS : B ne voit, ne modifie, ne supprime rien de A, y compris
-- via sync_push / sync_pull_v2 / sync_delete_all et les tombstones.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;

select t.login(:A);
set role authenticated;
select t.eq(jsonb_array_length(public.sync_push('[
  {"key":"kinetic:training:session:a1","value":{"id":"a1"},"base":null},
  {"key":"kinetic:xp","value":100,"base":null},
  {"key":"kinetic:training:session:a2","value":{"id":"a2"},"base":null}
]')), 3, 'A pousse 3 clés');
select t.eq((public.sync_push(jsonb_build_array(jsonb_build_object('key', 'kinetic:training:session:a2',
  'deleted', true, 'base', (select updated_at from public.user_storage where key = 'kinetic:training:session:a2'))))
  -> 0 ->> 'status'), 'ok', 'A supprime a2 (tombstone)');

-- B
select t.login(:B);
select t.eq((select count(*) from public.user_storage)::int, 0, 'B ne voit aucune ligne de A (SELECT)');
select t.eq(jsonb_array_length(public.sync_pull_v2(null) -> 'changes'), 0, 'sync_pull_v2 de B : rien de A (ni tombstone)');
select t.eq((select count(*) from public.sync_pull('1970-01-01', '', 1000))::int, 0, 'ancienne sync_pull de B : rien de A');
select t.eq((select count(*) from public.user_storage_usage)::int, 0, 'B ne lit pas le compteur de A');

with u as (update public.user_storage set value = '"pirate"' where user_id = :A returning 1)
select t.eq((select count(*) from u)::int, 0, 'UPDATE de B sur les lignes de A : 0 ligne');
with d as (delete from public.user_storage where user_id = :A returning 1)
select t.eq((select count(*) from d)::int, 0, 'DELETE de B sur les lignes de A : 0 ligne');
select t.throws($$insert into public.user_storage (user_id, key, value)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'kinetic:evil', '1')$$, '42501',
  'INSERT avec user_id = A refusé par RLS');

-- sync_push de B sur la même clé : crée la ligne de B, ne touche pas A.
select t.eq(t.item(public.sync_push('[{"key":"kinetic:xp","value":999,"base":null}]'), 'kinetic:xp') ->> 'status',
  'ok', 'B pousse kinetic:xp dans SON espace');
select t.eq((public.sync_delete_all() ->> 'deleted_count')::int, 1, 'sync_delete_all de B : seulement sa clé');
select t.throws($$select public.purge_sync_tombstones()$$, '42501', 'B ne peut pas purger');
select t.throws($$select public.recompute_user_storage_usage(null)$$, '42501', 'B ne peut pas recalculer les quotas');
select t.throws($$select public.user_storage_lock_user('aaaaaaaa-0000-0000-0000-00000000000a')$$, '42501',
  'B ne peut pas verrouiller le compte de A');
select t.throws($$insert into public.user_storage_usage (user_id) values ('bbbbbbbb-0000-0000-0000-00000000000b')$$,
  '42501', 'B ne peut pas écrire son compteur de quota');
select t.throws($$update public.sync_meta set tombstone_horizon = now()$$, '42501', 'B ne peut pas modifier sync_meta');

-- Retour à A : rien n'a bougé.
select t.login(:A);
select t.eq((select value from public.user_storage where key = 'kinetic:xp'), '100'::jsonb, 'valeur de A intacte');
select t.eq((select count(*) from public.user_storage where not deleted)::int, 2, 'A garde ses 2 clés vivantes');
select t.eq((select count(*) from public.user_storage where deleted)::int, 1, 'A garde sa tombstone');

-- anon : aucune RPC de synchro.
reset role;
select t.login(null);
set role anon;
select t.throws($$select public.sync_push('[]')$$, '42501', 'anon : sync_push refusé');
select t.throws($$select public.sync_pull_v2(null)$$, '42501', 'anon : sync_pull_v2 refusé');
select t.throws($$select public.sync_delete_all()$$, '42501', 'anon : sync_delete_all refusé');
-- Depuis 011 : anon n'a plus aucun droit sur user_storage (plus strict que « 0 ligne »).
select t.throws($$select count(*) from public.user_storage$$, '42501', 'anon : user_storage illisible (aucun droit)');
select t.throws($$select * from public.user_storage_usage$$, '42501', 'anon : compteur refusé');

-- authenticated sans sub (JWT invalide) : erreur explicite, pas d'écriture.
reset role;
select t.login(null);
set role authenticated;
select t.throws($$select public.sync_push('[]')$$, '42501', 'sync_push sans utilisateur : refusé');
reset role;
rollback;
