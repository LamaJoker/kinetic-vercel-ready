-- 30 — sync_pull_v2 : tombstones, pagination keyset avec égalités de timestamps,
-- limite d'octets, curseur dans le futur ; ancienne sync_pull sans tombstones.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
begin;
select t.login(:A);
set role authenticated;

select public.sync_push('[
  {"key":"p:1","value":1,"base":null},
  {"key":"p:2","value":2,"base":null},
  {"key":"p:3","value":null,"base":null}
]');
select public.sync_push(jsonb_build_array(jsonb_build_object('key', 'p:2', 'deleted', true,
  'base', (select updated_at from public.user_storage where key = 'p:2'))));

create temp table pull (res jsonb);
insert into pull select public.sync_pull_v2(null);
select t.eq((select res -> 'resync_required' from pull), 'false'::jsonb, 'pull complet : pas de resync');
select t.eq((select jsonb_array_length(res -> 'changes') from pull), 3, 'pull complet : 3 changements (dont la tombstone)');
select t.eq((select e -> 'deleted' from pull, jsonb_array_elements(res -> 'changes') e where e ->> 'key' = 'p:2'),
  'true'::jsonb, 'la tombstone p:2 est renvoyée avec deleted = true');
select t.eq((select (e -> 'deleted', e -> 'value') from pull, jsonb_array_elements(res -> 'changes') e where e ->> 'key' = 'p:3'),
  ('false'::jsonb, 'null'::jsonb), 'valeur JSON null vivante : deleted = false, value = null');
select t.ok((select res ? 'server_time' and res ? 'horizon' and res ? 'has_more' from pull), 'enveloppe complète');
select t.eq((select res -> 'has_more' from pull), 'false'::jsonb, 'has_more = false');
select t.eq((select array_agg(e ->> 'key' order by ord) from pull, jsonb_array_elements(res -> 'changes') with ordinality x(e, ord)),
  array['p:1', 'p:3', 'p:2'], 'ordre (updated_at, key) : la tombstone (plus récente) en dernier');

-- Ancienne RPC : jamais de tombstone.
select t.eq((select array_agg(key order by key) from public.sync_pull('1970-01-01', '', 500)), array['p:1', 'p:3'],
  'ancienne sync_pull : tombstones masquées');

-- Delta depuis le curseur : seulement ce qui suit.
select t.eq(jsonb_array_length(public.sync_pull_v2(
  (select (res -> 'changes' -> 2 ->> 'updated_at')::timestamptz from pull),
  (select res -> 'changes' -> 2 ->> 'key' from pull)) -> 'changes'), 0, 'delta après le dernier changement : vide');

-- Égalités de timestamps (forcées en superuser, triggers désactivés) + pagination par 2.
reset role;
set session_replication_role = replica;
insert into public.user_storage (user_id, key, value, updated_at, created_at)
select :A, 'eq:' || g, to_jsonb(g), '2025-01-01 00:00:00+00', now() from generate_series(1, 5) g;
update public.user_storage set updated_at = '2025-01-01 00:00:00+00' where user_id = :A and key = 'p:1';
set session_replication_role = origin;
set role authenticated;

create temp table pages (n int, k text, ts text);
do $$
declare v_since timestamptz := '2024-12-31'; v_after text := ''; v_res jsonb; v_n int := 0; e jsonb;
begin
  loop
    v_n := v_n + 1;
    v_res := public.sync_pull_v2(v_since, v_after, 2);
    for e in select * from jsonb_array_elements(v_res -> 'changes') loop
      insert into pages values (v_n, e ->> 'key', e ->> 'updated_at');
      v_since := (e ->> 'updated_at')::timestamptz; v_after := e ->> 'key';
    end loop;
    exit when not (v_res -> 'has_more')::boolean or v_n > 20;
  end loop;
end $$;
select t.eq((select count(*) from pages where k like 'eq:%' or k = 'p:1')::int, 6, 'pagination : 6 lignes au même timestamp');
select t.eq((select count(distinct k) from pages)::int, (select count(*) from pages)::int, 'pagination : aucun doublon');
select t.eq((select max(n) from pages), 4, 'pagination : 4 pages de 2 (6 lignes à égalité + p:2, p:3)');
select t.eq((select count(*) from pages)::int, 8, 'pagination : 8 lignes, aucune perdue');
select t.eq((select array_agg(k order by n, k) from pages where n = 1), array['eq:1', 'eq:2'], 'page 1 = eq:1, eq:2');

-- Limite d'octets par réponse (≈ 4 Mo) : jamais de page énorme, au moins une ligne.
reset role;
set session_replication_role = replica;
insert into public.user_storage (user_id, key, value, updated_at, created_at)
select :A, 'big:' || g, to_jsonb(repeat('b', 1000000)), '2025-06-01 00:00:00+00', now() from generate_series(1, 6) g;
set session_replication_role = origin;
set role authenticated;
select t.eq(jsonb_array_length(public.sync_pull_v2('2025-05-31', '', 500) -> 'changes'), 4,
  'réponse bornée à ~4 Mo : 4 valeurs de 1 Mo');
select t.eq(public.sync_pull_v2('2025-05-31', '', 500) -> 'has_more', 'true'::jsonb, 'has_more = true quand coupé par la taille');

-- Curseur dans le futur (ancien curseur empoisonné) : resync_required.
select t.eq(public.sync_pull_v2('2099-01-01', '', 500) ->> 'reason', 'cursor_in_future', 'curseur futur : resync_required');
select t.eq(public.sync_pull_v2('2099-01-01', '', 500) -> 'resync_required', 'true'::jsonb, 'curseur futur : drapeau');
-- p_limit borné.
select t.eq(jsonb_array_length(public.sync_pull_v2(null, '', 0) -> 'changes'), 1, 'p_limit ≤ 0 ramené à 1');
reset role;
rollback;
