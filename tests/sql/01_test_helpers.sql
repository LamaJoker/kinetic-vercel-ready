-- tests/sql/01_test_helpers.sql — assertions et utilisateurs de test (superuser).
-- Chaque fichier de test NN_*.sql s'exécute dans une transaction annulée à la fin
-- (sauf mention contraire) : les tests sont indépendants les uns des autres.

create schema if not exists t;
grant usage on schema t to public;

-- t.ok(condition, libellé) : lève une exception (=> échec du fichier) si faux.
create or replace function t.ok(cond boolean, label text) returns void
language plpgsql as $$
begin
  if cond is not true then
    raise exception 'ÉCHEC : %', label;
  end if;
  raise notice 'ok - %', label;
end $$;

create or replace function t.eq(got anyelement, expected anyelement, label text) returns void
language plpgsql as $$
begin
  if got is distinct from expected then
    raise exception 'ÉCHEC : % (obtenu %, attendu %)', label, got, expected;
  end if;
  raise notice 'ok - %', label;
end $$;

-- t.throws(sql, sqlstate attendu, libellé) : l'instruction doit échouer avec ce code.
create or replace function t.throws(stmt text, expected_state text, label text) returns void
language plpgsql as $$
declare v_state text;
begin
  begin
    execute stmt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if expected_state is null or v_state = expected_state then
      raise notice 'ok - % (%)', label, v_state;
      return;
    end if;
    raise exception 'ÉCHEC : % (sqlstate %, attendu %)', label, v_state, expected_state;
  end;
  raise exception 'ÉCHEC : % (aucune erreur levée)', label;
end $$;

-- Résultat d'un élément de sync_push par clé.
create or replace function t.item(res jsonb, k text) returns jsonb
language sql immutable as $$
  select e from jsonb_array_elements(res) e where e ->> 'key' = k limit 1
$$;

-- Usage attendu, recalculé depuis la table (référence pour le compteur incrémental).
create or replace function t.expected_usage(u uuid) returns table (keys integer, bytes bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select (count(*) filter (where not deleted))::integer,
         coalesce(sum(octet_length(value::text)) filter (where not deleted), 0)::bigint
  from public.user_storage where user_id = u
$$;

create or replace function t.actual_usage(u uuid) returns table (keys integer, bytes bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(max(keys), 0), coalesce(max(bytes), 0)::bigint
  from public.user_storage_usage where user_id = u
$$;

-- Bascule d'identité (à appeler en superuser avant `set role authenticated`).
create or replace function t.login(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  perform set_config('request.jwt.claim.role',
                     case when u is null then 'anon' else 'authenticated' end, false);
end $$;

grant execute on all functions in schema t to public;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'a@test.local'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'b@test.local')
on conflict (id) do nothing;
