-- 91 — Sécurité (011) : contrôles génériques sur le catalogue. Toute nouvelle table,
-- vue, fonction ou droit ajouté sans revue fait échouer ces assertions.
begin;

-- ── RLS ───────────────────────────────────────────────────────────────────
create temp view pub_tables as
select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

select t.eq((select string_agg(relname, ',') from pub_tables where relkind in ('r', 'p') and not relrowsecurity),
  null, 'RLS activée sur toutes les tables de public');
select t.eq((select string_agg(relname, ',') from pub_tables where relkind in ('r', 'p') and not relforcerowsecurity),
  null, 'RLS forcée sur toutes les tables de public');
select t.eq((select string_agg(c.relname, ',') from pg_class c
             where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
               and not coalesce('security_invoker=true' = any (c.reloptions), false)),
  null, 'toutes les vues de public sont SECURITY INVOKER');

-- ── Droits sur les tables / vues / séquences ──────────────────────────────
create temp view pub_privs as
select r.rolname, p.relname, x.priv
from pub_tables p
cross join (values ('anon'), ('authenticated'), ('public')) r(rolname)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) x(priv)
where p.relkind <> 'S'
  and case when r.rolname = 'public'
           then exists (select 1 from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                        where c.oid = p.oid and a.grantee = 0 and a.privilege_type = x.priv)
           else has_table_privilege(r.rolname, p.oid, x.priv) end
union all
select r.rolname, p.relname, x.priv
from pub_tables p
cross join (values ('anon'), ('authenticated')) r(rolname)
cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) x(priv)
where p.relkind = 'S' and has_sequence_privilege(r.rolname, p.oid, x.priv);

select t.eq((select string_agg(relname || ':' || priv, ',') from pub_privs where rolname = 'anon'),
  null, 'anon : aucun droit sur aucune table, vue ou séquence de public');
select t.eq((select string_agg(relname || ':' || priv, ',') from pub_privs where rolname = 'public'),
  null, 'PUBLIC : aucun droit sur les tables de public');
select t.eq((select string_agg(relname || ':' || priv, ',') from pub_privs
             where rolname = 'authenticated' and priv in ('TRUNCATE', 'REFERENCES', 'TRIGGER')),
  null, 'authenticated : ni TRUNCATE (contourne la RLS), ni REFERENCES, ni TRIGGER');
select t.eq((select string_agg(relname || ':' || priv, ',' order by relname, priv) from pub_privs
             where rolname = 'authenticated'),
  'daily_logs:SELECT,entitlements:SELECT,profiles:SELECT,'
  || 'push_subscriptions:DELETE,push_subscriptions:INSERT,push_subscriptions:SELECT,push_subscriptions:UPDATE,'
  || 'sync_meta:SELECT,user_stats:SELECT,'
  || 'user_storage:DELETE,user_storage:INSERT,user_storage:SELECT,user_storage:UPDATE,'
  || 'user_storage_delta:SELECT,user_storage_usage:SELECT',
  'authenticated : exactement la liste blanche de droits sur les tables');
select t.ok(has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE')
        and has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'UPDATE'),
  'profiles : full_name et avatar_url modifiables par leur propriétaire');
select t.ok(not has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE')
        and not has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')
        and not has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE'),
  'profiles : id, email et dates non modifiables par le client');
select t.ok(not has_table_privilege('authenticated', 'public.entitlements', 'INSERT, UPDATE, DELETE, TRUNCATE')
        and not exists (select 1 from information_schema.column_privileges
                        where table_schema = 'public' and table_name = 'entitlements'
                          and grantee in ('authenticated', 'anon', 'PUBLIC') and privilege_type <> 'SELECT'),
  'entitlements : aucune écriture client (ni table, ni colonne)');
select t.eq((select string_agg(polname || ':' || polcmd::text, ',') from pg_policy
             where polrelid = 'public.entitlements'::regclass and polcmd <> 'r'),
  null, 'entitlements : aucune policy d''écriture');
select t.eq((select string_agg(relname, ',') from pub_tables
             where relname in ('ai_coach_usage', 'ai_coach_limits', 'ai_coach_daily_global', 'rate_limits',
                               'vitals_metrics', 'vitals_rate_limit', 'workout_sessions', 'workout_sets',
                               'bodyweight_entries', 'weekly_goals')
               and (has_table_privilege('authenticated', oid, 'SELECT, INSERT, UPDATE, DELETE')
                    or has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE'))),
  null, 'tables internes et mortes : aucun accès direct client');
select t.ok(has_table_privilege('service_role', 'public.rate_limits', 'SELECT, INSERT, UPDATE, DELETE')
        and has_table_privilege('service_role', 'public.entitlements', 'SELECT, INSERT, UPDATE, DELETE'),
  'service_role garde l''accès complet');
select t.eq((select count(*) from pg_policy where polrelid = 'public.vitals_metrics'::regclass
             and 'anon'::regrole = any (polroles))::int, 0, 'vitals_metrics : plus de policy d''insertion anonyme');

-- ── Schéma public ─────────────────────────────────────────────────────────
select t.ok(not has_schema_privilege('anon', 'public', 'CREATE')
        and not has_schema_privilege('authenticated', 'public', 'CREATE')
        and not exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a
                        where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'CREATE'),
  'personne (hors propriétaire) ne peut créer d''objet dans public');

-- ── Fonctions ─────────────────────────────────────────────────────────────
create temp view pub_funcs as
select p.oid, p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig, p.proargtypes
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

select t.eq((select string_agg(sig, ',') from pub_funcs where has_function_privilege('anon', oid, 'EXECUTE')),
  'keep_alive()', 'anon : seule keep_alive() est exécutable');
select t.eq((select string_agg(sig, ',') from pub_funcs p, aclexplode(coalesce(
               (select proacl from pg_proc where oid = p.oid), acldefault('f', (select proowner from pg_proc where oid = p.oid)))) a
             where a.grantee = 0),
  null, 'PUBLIC : aucune fonction de public exécutable');
select t.eq((select string_agg(sig, ',' order by sig) from pub_funcs
             where has_function_privilege('authenticated', oid, 'EXECUTE')),
  'get_changes_since(timestamp with time zone),keep_alive(),'
  || 'sync_delete_all(),sync_lock_self(),sync_pull(timestamp with time zone,text,integer),'
  || 'sync_pull_v2(timestamp with time zone,text,integer),sync_push(jsonb),sync_usage(),'
  || 'upsert_daily_log(date,integer,integer,integer,jsonb),'
  || 'user_storage_max_bytes(),user_storage_max_keys(),user_storage_max_value_bytes()',
  'authenticated : exactement la liste blanche de fonctions');
select t.eq((select string_agg(sig, ',' order by sig) from pub_funcs
             where prosecdef and has_function_privilege('authenticated', oid, 'EXECUTE')),
  'sync_lock_self(),upsert_daily_log(date,integer,integer,integer,jsonb)',
  'SECURITY DEFINER exposées aux clients : seulement sync_lock_self et upsert_daily_log (auth.uid() interne)');

-- search_path fixé et sûr sur CHAQUE SECURITY DEFINER (public et autres schémas applicatifs).
create temp view definer_paths as
select p.oid::regprocedure::text as sig,
       (select regexp_replace(substr(c, 13), '\s', '', 'g') from unnest(p.proconfig) c
        where c like 'search_path=%') as path
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef
  and n.nspname not in ('pg_catalog', 'information_schema', 't')
  and not exists (select 1 from pg_depend d
                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

select t.ok((select count(*) from definer_paths) >= 15, 'au moins 15 fonctions SECURITY DEFINER inspectées');
select t.eq((select string_agg(sig, ',') from definer_paths where path is null),
  null, 'toute fonction SECURITY DEFINER fixe son search_path');
select t.eq((select string_agg(sig || '=' || path, ',') from definer_paths
             where exists (select 1 from unnest(string_to_array(nullif(nullif(path, '""'), ''), ',')) s
                           where trim(both '"' from s) not in ('pg_catalog', 'public', 'extensions', 'pg_temp'))),
  null, 'search_path des SECURITY DEFINER : uniquement pg_catalog, public, extensions, pg_temp');
select t.eq((select string_agg(sig || '=' || path, ',') from definer_paths
             where path like '%pg_temp%' and path not like '%pg_temp'),
  null, 'pg_temp toujours en dernier (jamais avant public)');

-- Aucune SECURITY DEFINER prenant un uuid (utilisateur arbitraire) n'est exposée aux clients.
select t.eq((select string_agg(sig, ',') from pub_funcs
             where prosecdef and 'uuid'::regtype::oid = any (proargtypes::oid[])
               and (has_function_privilege('anon', oid, 'EXECUTE')
                    or has_function_privilege('authenticated', oid, 'EXECUTE'))),
  null, 'SECURITY DEFINER avec paramètre utilisateur : service_role seulement');

-- ── Droits par défaut : un futur objet n'est ouvert à personne implicitement ──
set role postgres;
create table public.zz_future_table (id int);
create sequence public.zz_future_seq;
create function public.zz_future_fn() returns int language sql as 'select 1';
create view public.zz_future_view as select 1 as x;
reset role;
select t.ok(not has_table_privilege('anon', 'public.zz_future_table', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
        and not has_table_privilege('authenticated', 'public.zz_future_table', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
  'nouvelle table : fermée à anon et authenticated par défaut');
select t.ok(not has_table_privilege('anon', 'public.zz_future_view', 'SELECT')
        and not has_table_privilege('authenticated', 'public.zz_future_view', 'SELECT'),
  'nouvelle vue : fermée par défaut');
select t.ok(not has_sequence_privilege('anon', 'public.zz_future_seq', 'USAGE')
        and not has_sequence_privilege('authenticated', 'public.zz_future_seq', 'USAGE'),
  'nouvelle séquence : fermée par défaut');
select t.ok(not has_function_privilege('anon', 'public.zz_future_fn()', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.zz_future_fn()', 'EXECUTE'),
  'nouvelle fonction : non exécutable par anon / authenticated / PUBLIC par défaut');
select t.ok(has_table_privilege('service_role', 'public.zz_future_table', 'SELECT')
        and has_function_privilege('service_role', 'public.zz_future_fn()', 'EXECUTE'),
  'nouvel objet : service_role y a accès');

-- ── Contraintes de validation présentes et validées ───────────────────────
select t.eq((select count(*) from pg_constraint
             where conname in ('profiles_full_name_len', 'profiles_avatar_url_https', 'profiles_email_len',
                               'daily_logs_bounds', 'daily_logs_metadata_size',
                               'push_subscriptions_endpoint_known', 'push_subscriptions_keys_len',
                               'ai_coach_usage_prompt_chars')
               and convalidated)::int, 8, 'les 8 contraintes de validation d''entrée sont présentes et validées');
rollback;
