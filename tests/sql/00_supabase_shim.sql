-- tests/sql/00_supabase_shim.sql
-- Émulation minimale de l'environnement Supabase pour tester les migrations sur un
-- Postgres 16 nu. Exécuté par le superuser de bootstrap (supabase_admin), sur une
-- base vierge, AVANT les migrations (qui sont appliquées par le rôle postgres).
--
--  - postgres : NON superuser, BYPASSRLS, propriétaire du schéma public (comme Supabase) ;
--  - anon / authenticated / service_role (service_role en BYPASSRLS) ;
--  - auth.users, auth.uid() (lu dans request.jwt.claim.sub ou request.jwt.claims),
--    auth.role(), auth.jwt() ;
--  - pgcrypto dans le schéma extensions ;
--  - droits par défaut de Supabase : tout nouvel objet public est accordé à
--    anon/authenticated/service_role (les migrations doivent donc révoquer).

create role postgres login nosuperuser createrole createdb bypassrls;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

create schema extensions;
create extension pgcrypto schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), '')::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')::text
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to postgres, anon, authenticated, service_role;
grant all on auth.users to postgres;
grant execute on all functions in schema auth to postgres, anon, authenticated, service_role;

alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;

do $$ begin
  execute format('alter database %I owner to postgres', current_database());
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
