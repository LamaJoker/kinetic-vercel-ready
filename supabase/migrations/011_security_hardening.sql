-- ============================================================================
-- Migration 011 : durcissement sécurité du serveur
-- ============================================================================
-- Référence : docs/architecture/security.md (modèle de menace, garanties, interface
-- SQL des fonctions Edge). À appliquer APRÈS 010.
--
--  1. schéma public          plus de CREATE pour PUBLIC / anon / authenticated
--  2. tables de quota        ai_coach_limits, ai_coach_daily_global, rate_limits
--  3. RLS                    activée ET forcée sur toutes les tables de public
--  4. droits sur les tables  anon : plus rien ; authenticated : liste blanche
--                            (plus de TRUNCATE/REFERENCES/TRIGGER, daily_logs via RPC
--                            seulement, profiles : full_name et avatar_url seulement).
--                            Tables mortes (workout_sessions/sets, bodyweight_entries,
--                            weekly_goals, vitals_metrics, vitals_rate_limit) fermées
--                            aux clients, données conservées (SEC-03, SEC-04)
--  5. fonctions              SECURITY DEFINER réécrites avec search_path = '' (SEC-09 :
--                            digest() → sha256() natif) ; set_updated_at et
--                            get_changes_since en SECURITY INVOKER (SEC-12) ; plafond de
--                            10 abonnements push (SEC-06) ; quotas consume_ai_quota
--                            (horaire, journalier, global avec part plafonnée pour les
--                            comptes non payants : SEC-08), consume_rate_limit
--                            (report-error… : SEC-07), purge_security_counters ;
--                            user_storage_01_owner_check (écriture pour autrui refusée
--                            avant le trigger SECURITY DEFINER de 010) ;
--                            EXECUTE retiré à PUBLIC/anon/authenticated sauf liste blanche
--  6. droits par défaut      les FUTURS objets de public ne sont plus ouverts
--                            automatiquement à anon/authenticated/PUBLIC
--  7. validation d'entrée    contraintes CHECK (profiles, daily_logs, push_subscriptions,
--                            ai_coach_usage)
--  8. contrôle final         avertissement si une table de public reste sans RLS
--
-- NON DESTRUCTIVE : aucune table, colonne ni ligne de données supprimée. Seule la
-- policy d'insertion anonyme de vitals_metrics (collecte abandonnée) est retirée.
-- IDEMPOTENTE : rejouable sans erreur (testé par scripts/test-sql.sh).
-- COMPATIBLE : les chemins utilisés par les clients publiés (user_storage direct,
-- sync_*, upsert_daily_log, get_changes_since, user_storage_delta, keep_alive) restent
-- ouverts à authenticated (keep_alive : anon).
-- ============================================================================


-- ─── 0. Pré-requis ──────────────────────────────────────────────────────────
-- Les fonctions SECURITY DEFINER de quota lisent/écrivent des tables à RLS forcée
-- sans policy : leur propriétaire doit avoir BYPASSRLS (cas du rôle postgres Supabase).
do $$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Migration 011 : le rôle % doit avoir BYPASSRLS (ou être superuser)', current_user;
  end if;
  if to_regclass('public.user_storage_usage') is null then
    raise exception 'Migration 011 : appliquer d''abord la migration 010';
  end if;
end
$$;


-- ─── 1. Schéma public ───────────────────────────────────────────────────────
-- Personne d'autre que le propriétaire ne crée d'objet dans public : impossible
-- d'y glisser une fonction ou un opérateur homonyme pour détourner une fonction
-- SECURITY DEFINER dont le search_path contient public.
revoke create on schema public from public;
revoke create on schema public from anon, authenticated;


-- ─── 2. Tables internes de quota (nouvelles) ────────────────────────────────

-- Plafonds du coach IA (une seule ligne, modifiable par service_role / SQL Editor).
create table if not exists public.ai_coach_limits (
  id               smallint    primary key default 1 check (id = 1),
  enabled          boolean     not null default true,
  hourly_per_user  integer     not null default 10    check (hourly_per_user  between 1 and 1000),
  daily_per_user   integer     not null default 30    check (daily_per_user   between 1 and 10000),
  daily_global     integer     not null default 2000  check (daily_global     between 1 and 10000000),
  max_prompt_chars integer     not null default 40000 check (max_prompt_chars between 1 and 1000000),
  updated_at       timestamptz not null default now()
);
-- Part du plafond global ouverte aux comptes NON payants (essai de 7 jours offert à
-- chaque inscription, gratuit, Pro expiré). Sans elle, quelques dizaines de comptes
-- jetables épuisaient chaque jour le plafond global au détriment des abonnés payants.
alter table public.ai_coach_limits
  add column if not exists daily_global_unpaid integer not null default 1000
    constraint ai_coach_limits_daily_global_unpaid_check check (daily_global_unpaid between 1 and 10000000);
insert into public.ai_coach_limits (id) values (1) on conflict (id) do nothing;

-- Compteur global du coach IA par jour UTC (borne de coût tous comptes confondus).
create table if not exists public.ai_coach_daily_global (
  day        date        primary key,
  requests   integer     not null default 0 check (requests >= 0),
  updated_at timestamptz not null default now()
);
-- Dont requêtes de comptes non payants (part plafonnée par daily_global_unpaid).
alter table public.ai_coach_daily_global
  add column if not exists unpaid_requests integer not null default 0
    constraint ai_coach_daily_global_unpaid_requests_check check (unpaid_requests >= 0);

-- Limiteur générique à fenêtre fixe. subject = HMAC de l'IP, UUID ou « global » :
-- jamais d'IP brute (voir docs/architecture/security.md).
create table if not exists public.rate_limits (
  scope        text        not null check (scope   ~ '^[a-z0-9_-]{1,40}$'),
  subject      text        not null check (subject ~ '^[A-Za-z0-9_-]{1,128}$'),
  window_start timestamptz not null,
  window_end   timestamptz not null,
  count        integer     not null default 0 check (count >= 0),
  primary key (scope, subject)
);
create index if not exists idx_rate_limits_window_end on public.rate_limits (window_end);

create index if not exists idx_ai_coach_usage_requested_at on public.ai_coach_usage (requested_at);


-- ─── 3. RLS activée et forcée partout ───────────────────────────────────────
-- Toutes les tables ordinaires de public (y compris celles créées par 001→010).
-- FORCE n'a d'effet que sur un propriétaire sans BYPASSRLS ; c'est une défense en
-- profondeur, pas une garantie (service_role et postgres ont BYPASSRLS).
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      -- Objets dont le rôle courant est propriétaire (les autres, s'il y en a, sont
      -- signalés par le contrôle final de la section 8).
      and pg_has_role(current_user, c.relowner, 'MEMBER')
  loop
    execute format('alter table %s enable row level security', r.tbl);
    execute format('alter table %s force row level security', r.tbl);
  end loop;
end
$$;


-- ─── 4. Droits sur les tables, vues et séquences ────────────────────────────
-- 4a. Remise à zéro : anon n'a plus aucun droit ; authenticated perd tout ce qui
-- n'est pas explicitement ré-accordé en 4b. service_role garde tout.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as obj, c.relkind
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
      -- Objets dont le rôle courant est propriétaire (les autres, s'il y en a, sont
      -- signalés par le contrôle final de la section 8).
      and pg_has_role(current_user, c.relowner, 'MEMBER')
  loop
    if r.relkind = 'S' then
      execute format('revoke all on sequence %s from public, anon, authenticated', r.obj);
      execute format('grant all on sequence %s to service_role', r.obj);
    else
      execute format('revoke all on table %s from public, anon, authenticated', r.obj);
      execute format('grant all on table %s to service_role', r.obj);
    end if;
  end loop;
end
$$;

-- 4b. Liste blanche authenticated (toujours filtrée par RLS au propriétaire).
-- user_storage : accès direct des clients publiés (SupabaseStorage / SupabaseSyncRemote).
grant select, insert, update, delete on public.user_storage to authenticated;
-- daily_logs : lecture seule ; l'écriture passe par upsert_daily_log (bornes validées).
grant select on public.daily_logs to authenticated;
grant select on public.user_stats to authenticated;
-- profiles : lecture ; mise à jour de full_name et avatar_url uniquement (pas id, email, dates).
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;
-- entitlements : lecture de SON plan uniquement, jamais d'écriture.
grant select on public.entitlements to authenticated;
-- Lus par les RPC SECURITY INVOKER sync_usage / sync_pull_v2.
grant select on public.user_storage_usage to authenticated;
grant select on public.sync_meta to authenticated;
-- Vue legacy (anciens clients), SECURITY INVOKER : RLS de user_storage.
grant select on public.user_storage_delta to authenticated;
-- push_subscriptions : chaque utilisateur gère ses propres abonnements (validés en 7).
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Non ré-accordées (internes ou mortes) : ai_coach_usage, ai_coach_limits,
-- ai_coach_daily_global, rate_limits, vitals_metrics, vitals_rate_limit,
-- workout_sessions, workout_sets, bodyweight_entries, weekly_goals.

-- 4c. Vues : exécutées avec les droits de l'appelant (RLS appliquée).
alter view public.user_stats         set (security_invoker = true);
alter view public.user_storage_delta set (security_invoker = true);

-- 4d. Collecte vitals abandonnée (SEC-03) : plus d'insertion anonyme.
drop policy if exists "vitals_insert_anon" on public.vitals_metrics;

-- 4e. profiles : la policy de 002 exigeait avatar_url ~ '^https://' alors que
-- handle_new_user écrit '' : toute mise à jour d'un profil sans avatar était refusée.
-- La validation des valeurs passe aux contraintes CHECK (section 7), appliquées à
-- tous les chemins d'écriture.
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- ─── 5. Fonctions ───────────────────────────────────────────────────────────

-- 5a. Triggers / utilitaires sans besoin de privilèges.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- Ancien RPC (002) : SECURITY INVOKER, la RLS de user_storage s'applique.
create or replace function public.get_changes_since(p_since timestamptz)
returns table (key text, value jsonb, updated_at timestamptz)
language sql
security invoker
stable
set search_path = ''
as $$
  select s.key, s.value, s.updated_at
  from public.user_storage s
  where s.user_id = auth.uid() and not s.deleted and s.updated_at > p_since
  order by s.updated_at asc;
$$;

-- 5b. Création du profil à l'inscription : métadonnées bornées (SEC-12).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name   text := pg_catalog.left(pg_catalog.regexp_replace(
                    coalesce(new.raw_user_meta_data ->> 'full_name', ''), '[[:cntrl:]]', '', 'g'), 100);
  v_avatar text := coalesce(new.raw_user_meta_data ->> 'avatar_url', '');
begin
  if v_avatar !~ '^https://[^[:space:][:cntrl:]\\]+$' or pg_catalog.char_length(v_avatar) > 2048 then
    v_avatar := '';
  end if;
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, pg_catalog.left(new.email, 320), v_name, v_avatar)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.create_entitlement_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.entitlements (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 5c. Journal quotidien : seul chemin d'écriture de daily_logs pour les clients.
create or replace function public.upsert_daily_log(
  p_date       date,
  p_xp_earned  integer,
  p_tasks_done integer,
  p_streak_day integer,
  p_metadata   jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'upsert_daily_log: non authentifié' using errcode = '42501';
  end if;
  if p_date is null or p_xp_earned is null or p_tasks_done is null or p_streak_day is null then
    raise exception 'upsert_daily_log: paramètre manquant' using errcode = '22023';
  end if;
  if p_xp_earned < 0 or p_xp_earned > 100000 then
    raise exception 'xp_earned hors borne (0-100000): %', p_xp_earned using errcode = 'P0001';
  end if;
  if p_tasks_done < 0 or p_tasks_done > 1000 then
    raise exception 'tasks_done hors borne (0-1000): %', p_tasks_done using errcode = 'P0001';
  end if;
  if p_streak_day < 0 or p_streak_day > 100000 then
    raise exception 'streak_day hors borne: %', p_streak_day using errcode = 'P0001';
  end if;
  if p_date > current_date + 1 or p_date < current_date - 90 then
    raise exception 'date hors fenêtre autorisée: %', p_date using errcode = 'P0001';
  end if;
  if p_metadata is not null and (pg_catalog.jsonb_typeof(p_metadata) <> 'object'
                                 or pg_catalog.octet_length(p_metadata::text) > 4096) then
    raise exception 'metadata: objet JSON de 4 Ko maximum' using errcode = 'P0001';
  end if;

  insert into public.daily_logs (user_id, date, xp_earned, tasks_done, streak_day, metadata)
  values (v_uid, p_date, p_xp_earned, p_tasks_done, p_streak_day, p_metadata)
  on conflict (user_id, date)
  do update set
    xp_earned  = greatest(excluded.xp_earned,  public.daily_logs.xp_earned),
    tasks_done = greatest(excluded.tasks_done, public.daily_logs.tasks_done),
    streak_day = excluded.streak_day,
    metadata   = coalesce(excluded.metadata, public.daily_logs.metadata);
end;
$$;

-- 5d. Droit Pro (009) : search_path vide, toujours réservé au service_role.
create or replace function public.is_pro(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and (
        (e.tier = 'pro' and (e.pro_until is null or e.pro_until > pg_catalog.now()))
        or (e.trial_ends_at is not null and e.trial_ends_at > pg_catalog.now())
      )
  );
$$;

-- 5e. Rate limit vitals (fonction morte, plus aucun INSERT client) : SEC-09.
-- digest() de pgcrypto n'était pas dans le search_path (schéma extensions sur
-- Supabase) ; sha256() est natif (pg_catalog, PG ≥ 11) : aucune dépendance à
-- l'emplacement de pgcrypto.
create or replace function public.check_vitals_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip_hash  text;
  v_count    integer;
  v_max      constant integer  := 60;
  v_window_s constant interval := interval '1 minute';
begin
  v_ip_hash := coalesce(
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      (pg_catalog.current_setting('request.headers', true))::json ->> 'x-forwarded-for', 'UTF8')), 'hex'),
    'unknown');

  insert into public.vitals_rate_limit as v (ip_hash, window_start, count)
  values (v_ip_hash, pg_catalog.now(), 1)
  on conflict (ip_hash) do update
  set window_start = case when pg_catalog.now() - v.window_start > v_window_s then pg_catalog.now() else v.window_start end,
      count        = case when pg_catalog.now() - v.window_start > v_window_s then 1 else v.count + 1 end
  returning v.count into v_count;

  if v_count > v_max then
    raise exception 'Rate limit exceeded for vitals_metrics' using errcode = 'P0003';
  end if;
  return new;
end;
$$;

-- 5f. Plafond d'abonnements push par utilisateur (SEC-06). SECURITY INVOKER :
-- l'utilisateur ne compte que ses lignes (RLS), le service_role compte tout.
create or replace function public.push_subscriptions_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is not distinct from old.user_id then
      return new;
    end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('push_sub:' || new.user_id::text));
  -- L'endpoint inséré lui-même n'est pas compté : un upsert « on conflict (endpoint) »
  -- (navigateur qui ré-enregistre un abonnement existant, client web d'avant 9.3.0)
  -- déclenche ce trigger BEFORE INSERT avant de devenir une mise à jour ; il ne crée
  -- pas de nouvel abonnement et doit passer même au plafond.
  select count(*) into v_n
  from public.push_subscriptions s
  where s.user_id = new.user_id
    and s.endpoint <> new.endpoint;
  if v_n >= 10 then
    raise exception 'push_subscriptions: 10 abonnements maximum par utilisateur' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace trigger push_subscriptions_10_cap
  before insert or update of user_id on public.push_subscriptions
  for each row
  execute function public.push_subscriptions_cap();

-- 5f bis. user_storage : refus d'une écriture pour un autre utilisateur AVANT tout
-- code privilégié. Le trigger BEFORE user_storage_10_before_write (010, SECURITY
-- DEFINER) s'exécute avant le contrôle RLS WITH CHECK : un INSERT portant le user_id
-- d'une victime lui faisait prendre (et écrire) la ligne de compteur de la victime
-- avant d'être refusé ; en rafale, la synchro de la victime était bloquée. Ce
-- trigger (déclenché en premier : ordre alphabétique « 01 » < « 05 » < « 10 ») refuse
-- en 42501 sans rien verrouiller. SECURITY INVOKER : current_user est le rôle de
-- l'appelant ; service_role, postgres et les fonctions SECURITY DEFINER ne sont pas
-- concernés.
create or replace function public.user_storage_owner_check()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.user_id is distinct from auth.uid() then
    raise exception 'user_storage: écriture pour un autre utilisateur refusée' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger user_storage_01_owner_check
  before insert or update on public.user_storage
  for each row
  execute function public.user_storage_owner_check();

-- 5g. Quota du coach IA : plafonds horaire / journalier par utilisateur et
-- journalier global, atomiques (verrou par utilisateur + ligne globale du jour).
create or replace function public.consume_ai_quota(
  p_user         uuid,
  p_prompt_chars integer default 0,
  p_hourly_limit integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg        public.ai_coach_limits;
  v_now        timestamptz := pg_catalog.now();
  v_day        date := (pg_catalog.now() at time zone 'utc')::date;
  v_hourly     integer;
  v_hour_n     integer;
  v_day_n      integer;
  v_hour_first timestamptz;
  v_day_first  timestamptz;
  v_global     integer;
  v_paid       boolean;
begin
  if p_user is null then
    raise exception 'consume_ai_quota: p_user requis' using errcode = '22023';
  end if;
  if p_prompt_chars is null or p_prompt_chars < 0 then
    raise exception 'consume_ai_quota: p_prompt_chars invalide' using errcode = '22023';
  end if;
  if p_hourly_limit is not null and p_hourly_limit < 0 then
    raise exception 'consume_ai_quota: p_hourly_limit invalide' using errcode = '22023';
  end if;

  select * into v_cfg from public.ai_coach_limits where id = 1;
  if not found or not v_cfg.enabled then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'disabled', 'retry_after_seconds', 3600);
  end if;
  if p_prompt_chars > v_cfg.max_prompt_chars then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'prompt_too_large', 'retry_after_seconds', 0);
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'consume_ai_quota: utilisateur inconnu' using errcode = '23503';
  end if;

  v_hourly := least(v_cfg.hourly_per_user, coalesce(p_hourly_limit, v_cfg.hourly_per_user));

  -- Même clé de verrou que consume_ai_coach_quota (009) : les deux s'excluent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_coach:' || p_user::text));

  select count(*) filter (where a.requested_at > v_now - interval '1 hour'),
         count(*),
         min(a.requested_at) filter (where a.requested_at > v_now - interval '1 hour'),
         min(a.requested_at)
  into v_hour_n, v_day_n, v_hour_first, v_day_first
  from public.ai_coach_usage a
  where a.user_id = p_user
    and a.requested_at > v_now - interval '24 hours';

  if v_hour_n >= v_hourly then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_hourly', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from coalesce(v_hour_first, v_now) + interval '1 hour' - v_now)))::integer);
  end if;
  if v_day_n >= v_cfg.daily_per_user then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'user_daily', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from coalesce(v_day_first, v_now) + interval '24 hours' - v_now)))::integer);
  end if;

  -- Abonné PAYANT (pas un essai) : seul à pouvoir consommer au-delà de la part non payante.
  v_paid := exists (
    select 1 from public.entitlements e
    where e.user_id = p_user and e.tier = 'pro'
      and (e.pro_until is null or e.pro_until > v_now));

  -- Plafond global (et part non payante) : incrément conditionnel sous verrou de
  -- ligne (atomique).
  insert into public.ai_coach_daily_global as g (day, requests, unpaid_requests, updated_at)
  values (v_day, 1, case when v_paid then 0 else 1 end, v_now)
  on conflict (day) do update
    set requests        = g.requests + 1,
        unpaid_requests = g.unpaid_requests + excluded.unpaid_requests,
        updated_at      = excluded.updated_at
    where g.requests < v_cfg.daily_global
      and (v_paid or g.unpaid_requests < v_cfg.daily_global_unpaid)
  returning g.requests into v_global;
  if v_global is null then
    return pg_catalog.jsonb_build_object('allowed', false, 'reason', 'global_daily', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from ((v_day + 1)::timestamp at time zone 'utc') - v_now)))::integer);
  end if;

  insert into public.ai_coach_usage (user_id, requested_at, prompt_chars)
  values (p_user, v_now, p_prompt_chars);

  return pg_catalog.jsonb_build_object(
    'allowed', true, 'reason', 'ok', 'retry_after_seconds', 0,
    'remaining_hour', v_hourly - v_hour_n - 1,
    'remaining_day', v_cfg.daily_per_user - v_day_n - 1);
end;
$$;

-- Compatibilité 009 (ai-coach déployé) : même signature, plafonds 011 appliqués.
create or replace function public.consume_ai_coach_quota(
  p_user         uuid,
  p_limit        integer default 10,
  p_prompt_chars integer default 0
)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select (public.consume_ai_quota(p_user, greatest(coalesce(p_prompt_chars, 0), 0),
                                  greatest(coalesce(p_limit, 0), 0)) ->> 'allowed')::boolean;
$$;

-- 5h. Limiteur générique à fenêtre fixe (report-error, delete-account…).
create or replace function public.consume_rate_limit(
  p_scope          text,
  p_subject        text,
  p_limit          integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now   timestamptz := pg_catalog.now();
  v_start timestamptz;
  v_end   timestamptz;
  v_count integer;
begin
  if p_scope is null or p_scope !~ '^[a-z0-9_-]{1,40}$'
     or p_subject is null or p_subject !~ '^[A-Za-z0-9_-]{1,128}$'
     or p_limit is null or p_limit not between 1 and 1000000
     or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'consume_rate_limit: paramètres invalides' using errcode = '22023';
  end if;

  v_start := pg_catalog.to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
  v_end := v_start + pg_catalog.make_interval(secs => p_window_seconds);

  insert into public.rate_limits as r (scope, subject, window_start, window_end, count)
  values (p_scope, p_subject, v_start, v_end, 1)
  on conflict (scope, subject) do update
    set count        = case when r.window_start = excluded.window_start then r.count + 1 else 1 end,
        window_start = excluded.window_start,
        window_end   = excluded.window_end
    where r.window_start <> excluded.window_start or r.count < p_limit
  returning r.count into v_count;

  if v_count is null then
    -- Refus : le compteur n'est plus incrémenté (pas d'amplification).
    select r.count, r.window_end into v_count, v_end
    from public.rate_limits r where r.scope = p_scope and r.subject = p_subject;
    return pg_catalog.jsonb_build_object('allowed', false, 'count', v_count, 'limit', p_limit,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from v_end - v_now)))::integer);
  end if;

  return pg_catalog.jsonb_build_object('allowed', true, 'count', v_count, 'limit', p_limit,
    'retry_after_seconds', 0);
end;
$$;

-- 5i. Purge des compteurs (quotidienne).
create or replace function public.purge_security_counters()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_usage  bigint;
  v_global bigint;
  v_rl     bigint;
begin
  delete from public.ai_coach_usage where requested_at < pg_catalog.now() - interval '30 days';
  get diagnostics v_usage = row_count;
  delete from public.ai_coach_daily_global where day < (pg_catalog.now() at time zone 'utc')::date - 30;
  get diagnostics v_global = row_count;
  delete from public.rate_limits where window_end < pg_catalog.now();
  get diagnostics v_rl = row_count;
  delete from public.vitals_rate_limit where window_start < pg_catalog.now() - interval '1 day';
  return pg_catalog.jsonb_build_object('ai_coach_usage', v_usage, 'ai_coach_daily_global', v_global,
                                       'rate_limits', v_rl);
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$
      select cron.schedule('kinetic-purge-security-counters', '23 4 * * *',
                           'select public.purge_security_counters()')
    $cron$;
  end if;
exception when others then
  raise notice 'pg_cron : planification de la purge ignorée (%)', sqlerrm;
end
$$;

-- 5j. Droits d'exécution : retirés à tous, puis liste blanche.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and pg_has_role(current_user, p.proowner, 'MEMBER')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end
$$;

-- Clients connectés : synchro (010), journal, anciens RPC, limites lues par sync_usage.
grant execute on function public.sync_push(jsonb)                                  to authenticated;
grant execute on function public.sync_pull_v2(timestamptz, text, integer)          to authenticated;
grant execute on function public.sync_pull(timestamptz, text, integer)             to authenticated;
grant execute on function public.sync_delete_all()                                 to authenticated;
grant execute on function public.sync_usage()                                      to authenticated;
grant execute on function public.sync_lock_self()                                  to authenticated;
grant execute on function public.user_storage_max_keys()                           to authenticated;
grant execute on function public.user_storage_max_bytes()                          to authenticated;
grant execute on function public.user_storage_max_value_bytes()                    to authenticated;
grant execute on function public.upsert_daily_log(date, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.get_changes_since(timestamptz)                    to authenticated;
-- Ping du workflow keep-alive (clé anon) : SECURITY INVOKER, ne lit aucune table.
grant execute on function public.keep_alive()                                      to anon, authenticated;


-- ─── 6. Droits par défaut des futurs objets ─────────────────────────────────
-- Supabase accorde par défaut tout objet créé dans public à anon et authenticated
-- (et EXECUTE à PUBLIC pour toute fonction). Pour les objets créés DÉSORMAIS par le
-- rôle qui applique les migrations, plus rien n'est ouvert implicitement : chaque
-- migration doit accorder explicitement ce dont les clients ont besoin.
-- (Les droits par défaut de supabase_admin ne peuvent pas être modifiés ici.)
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;


-- ─── 7. Validation d'entrée côté serveur ────────────────────────────────────
-- Contraintes ajoutées NOT VALID (appliquées immédiatement aux nouvelles écritures),
-- puis validées si les données existantes les respectent ; sinon un NOTICE est émis
-- et la contrainte reste NOT VALID (aucune donnée supprimée ni modifiée).
do $$
declare
  c record;
begin
  for c in
    select * from (values
      ('public.profiles', 'profiles_full_name_len',
       'full_name is null or char_length(full_name) <= 100'),
      ('public.profiles', 'profiles_avatar_url_https',
       $c$avatar_url is null or avatar_url = '' or (avatar_url ~ '^https://[^[:space:][:cntrl:]\\]+$' and char_length(avatar_url) <= 2048)$c$),
      ('public.profiles', 'profiles_email_len',
       'email is null or char_length(email) <= 320'),
      ('public.daily_logs', 'daily_logs_bounds',
       $c$xp_earned <= 100000 and tasks_done <= 1000 and streak_day <= 100000 and date >= date '2000-01-01'$c$),
      ('public.daily_logs', 'daily_logs_metadata_size',
       $c$metadata is null or (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096)$c$),
      ('public.push_subscriptions', 'push_subscriptions_endpoint_known',
       $c$char_length(endpoint) <= 1000 and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)/[A-Za-z0-9._~:/?#@!$&''()*+,;=%-]*$'$c$),
      ('public.push_subscriptions', 'push_subscriptions_keys_len',
       $c$p256dh ~ '^[A-Za-z0-9_=+/-]{1,200}$' and auth ~ '^[A-Za-z0-9_=+/-]{1,100}$' and (user_agent is null or char_length(user_agent) <= 500)$c$),
      ('public.ai_coach_usage', 'ai_coach_usage_prompt_chars',
       'prompt_chars between 0 and 1000000')
    ) as v(tbl, name, expr)
  loop
    if not exists (select 1 from pg_constraint
                   where conname = c.name and conrelid = c.tbl::regclass) then
      execute format('alter table %s add constraint %I check (%s) not valid', c.tbl, c.name, c.expr);
    end if;
    if exists (select 1 from pg_constraint
               where conname = c.name and conrelid = c.tbl::regclass and not convalidated) then
      begin
        execute format('alter table %s validate constraint %I', c.tbl, c.name);
      exception when check_violation then
        raise notice 'Migration 011 : % reste NOT VALID (données existantes non conformes, à nettoyer)', c.name;
      end;
    end if;
  end loop;
end
$$;


-- ─── 8. Contrôle final ──────────────────────────────────────────────────────
-- Signale (sans échouer) toute table de public restée sans RLS, par exemple parce
-- qu'elle appartient à un autre rôle que celui qui applique la migration.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as tbl, pg_get_userbyid(c.relowner) as owner
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  loop
    raise warning 'Migration 011 : % (propriétaire %) n''a pas la RLS activée : à traiter manuellement', r.tbl, r.owner;
  end loop;
end
$$;
