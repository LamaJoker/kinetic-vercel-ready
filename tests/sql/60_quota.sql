-- 60 — Quota incrémental : compteur exact après insert / update / tombstone /
-- recréation / suppression physique, sans relire tout le stockage.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;
select t.login(:A);
set role authenticated;

select public.sync_push('[{"key":"q:1","value":{"a":1},"base":null},{"key":"q:2","value":"deux","base":null}]');
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)), 'après insert (sync_push)');
select t.eq((select keys from t.actual_usage(:A)), 2, '2 clés comptées');
select t.eq((select bytes from t.actual_usage(:A)), (octet_length('{"a": 1}') + octet_length('"deux"'))::bigint,
  'octets = somme exacte des valeurs');

insert into public.user_storage (user_id, key, value) values (:A, 'q:3', '[1,2,3]')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)), 'après insert direct');

insert into public.user_storage (user_id, key, value) values (:A, 'q:3', '"une valeur bien plus longue"')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)),
  'après upsert (BEFORE INSERT + BEFORE UPDATE : pas de double comptage)');
select t.eq((select keys from t.actual_usage(:A)), 3, 'upsert d''une clé existante : pas de nouvelle clé');

update public.user_storage set value = '1' where key = 'q:3';
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)), 'après update (réduction)');

select public.sync_push(jsonb_build_array(jsonb_build_object('key', 'q:1', 'deleted', true,
  'base', (select updated_at from public.user_storage where key = 'q:1'))));
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)), 'après tombstone');
select t.eq((select keys from t.actual_usage(:A)), 2, 'tombstone : clé décomptée');

delete from public.user_storage where key = 'q:2'; -- ancien client : devient tombstone
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)), 'après DELETE client');

insert into public.user_storage (user_id, key, value) values (:A, 'q:2', '"revenue"')
on conflict (user_id, key) do update set value = excluded.value;
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)),
  'après recréation d''une tombstone');

select public.sync_delete_all();
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (0, 0::bigint), 'après sync_delete_all : 0 clé, 0 octet');

-- Suppressions physiques (purge / service) : compteur cohérent.
select public.sync_push('[{"key":"q:9","value":"x","base":null}]');
reset role;
set role service_role;
delete from public.user_storage where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and key = 'q:9';
reset role;
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)),
  'après DELETE physique (service_role)');
select t.ok(not exists (select 1 from public.user_storage where user_id = :A and key = 'q:9'), 'service_role : DELETE physique');

-- Dépassement : l'écriture directe est refusée (P0002), la réduction reste permise.
select t.login(:A);
set role authenticated;
select public.sync_push('[{"key":"q:r","value":"une longue valeur","base":null}]');
reset role;
update public.user_storage_usage set bytes = public.user_storage_max_bytes() - 5 where user_id = :A;
select t.login(:A);
set role authenticated;
select t.throws($$insert into public.user_storage (user_id, key, value)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'q:huge', to_jsonb(repeat('h', 100)))$$, 'P0002', 'upsert direct au-delà du quota : P0002');
reset role;
update public.user_storage_usage set bytes = public.user_storage_max_bytes() + 1000 where user_id = :A;
set role authenticated;
select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'q:r', 'value', '"r"'::jsonb,
  'base', (select updated_at from public.user_storage where key = 'q:r')))) -> 0 ->> 'status', 'ok',
  'compte au-delà du quota : réduire une valeur reste possible');
reset role;

-- Recalcul de réparation (service_role) : rétablit la valeur exacte.
set role service_role;
select public.recompute_user_storage_usage('aaaaaaaa-0000-0000-0000-00000000000a');
reset role;
select t.eq((select (keys, bytes) from t.actual_usage(:A)), (select (keys, bytes) from t.expected_usage(:A)),
  'recompute_user_storage_usage rétablit le compteur exact');

-- Le compteur de B n'a jamais bougé.
select t.eq((select (keys, bytes) from t.actual_usage(:B)), (select (keys, bytes) from t.expected_usage(:B)), 'compteur de B exact');

-- Le trigger ne relit plus tout le stockage : coût indépendant du volume (5 000 lignes).
set session_replication_role = replica;
insert into public.user_storage (user_id, key, value)
select :A, 'bulk:' || g, to_jsonb(repeat('v', 2000)) from generate_series(1, 5000) g;
set session_replication_role = origin;
select public.recompute_user_storage_usage(:A);
do $$
declare t0 timestamptz; i int;
begin
  perform t.login('aaaaaaaa-0000-0000-0000-00000000000a');
  t0 := clock_timestamp();
  for i in 1..50 loop
    insert into public.user_storage (user_id, key, value) values ('aaaaaaaa-0000-0000-0000-00000000000a', 'kinetic:xp', to_jsonb(i))
    on conflict (user_id, key) do update set value = excluded.value;
  end loop;
  perform t.ok(clock_timestamp() - t0 < interval '1 second',
    format('50 upserts avec 5 000 clés (10 Mo) en %s (< 1 s)', clock_timestamp() - t0));
end $$;
rollback;
