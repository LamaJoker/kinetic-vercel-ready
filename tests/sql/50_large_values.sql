-- 50 — Grandes valeurs : plus de limite d'index à 2,7 Ko (SEC-01 / PERF-01).
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
begin;
select t.login(:A);
set role authenticated;

-- 100 Ko de données peu compressibles (base64 de octets aléatoires).
create temp table big (v jsonb);
insert into big select to_jsonb(string_agg(encode(extensions.gen_random_bytes(768), 'base64'), '')) from generate_series(1, 100);
select t.ok((select octet_length(v::text) from big) > 100000, 'valeur de test > 100 Ko');

insert into public.user_storage (user_id, key, value) select :A, 'big:direct', v from big
on conflict (user_id, key) do update set value = excluded.value;
select t.ok(exists (select 1 from public.user_storage where key = 'big:direct'), 'upsert direct de 100 Ko accepté');

select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'big:push', 'value', (select v from big), 'base', null)))
  -> 0 ->> 'status', 'ok', 'sync_push de 100 Ko accepté');

-- Séance réaliste : 36 exercices × 5 séries (≈ 28 Ko, rejetée avant 010).
select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'kinetic:training:session:long',
  'value', jsonb_build_object('id', 'long', 'entries', (select jsonb_agg(jsonb_build_object('exerciseId', 'ex-' || e,
    'sets', (select jsonb_agg(jsonb_build_object('setIndex', s, 'reps', 8, 'weightKg', 100, 'rpe', 8,
      'performedAt', '2026-11-25T10:00:00.000Z')) from generate_series(1, 5) s))) from generate_series(1, 36) e)),
  'base', null))) -> 0 ->> 'status', 'ok', 'séance de 36 exercices × 5 séries acceptée');

-- Proche de la limite de 1 Mo : accepté ; au-delà : rejeté proprement (pas d'exception).
select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'big:limit',
  'value', repeat('z', 1048574), 'base', null))) -> 0 ->> 'status', 'ok', 'valeur de 1 048 576 octets acceptée');
select t.eq(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'big:over',
  'value', repeat('z', 1048575), 'base', null))) -> 0 ->> 'reason', 'value_too_large', '1 048 577 octets : value_too_large');
select t.ok(exists (select 1 from jsonb_array_elements(public.sync_pull_v2(null, '', 1000) -> 'changes') e
  where e ->> 'key' = 'big:push' and e -> 'value' = (select v from big)), 'la valeur de 100 Ko est relue à l''identique');
reset role;
rollback;
