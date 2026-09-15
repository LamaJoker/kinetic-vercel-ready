-- ============================================================================
-- Migration 009 : synchro fiable, droits Pro côté serveur, quota IA atomique
-- ============================================================================
-- 1. sync_pull()                  delta sync paginé sur horloge serveur
-- 2. check_user_storage_quota()   quota corrigé (update ≠ nouvelle clé, 20 000 clés)
-- 3. entitlements                 source de vérité du plan free/Pro (non modifiable par le client)
-- 4. consume_ai_coach_quota()     rate limit atomique du coach IA (fail-closed)
-- 5. keep_alive()                 ping léger utilisé par le workflow GitHub keep-alive
--
-- Idempotente : peut être rejouée sans erreur.
-- ============================================================================


-- ─── 1. Delta sync paginé ───────────────────────────────────────────────────
-- Renvoie clés + valeurs + updated_at SERVEUR strictement après (p_since, p_after_key),
-- triés par (updated_at, key). Pagination par keyset : pas de trou ni de doublon
-- même si plusieurs lignes partagent le même updated_at.
-- SECURITY INVOKER → les policies RLS de user_storage s'appliquent.

create index if not exists idx_user_storage_user_updated_key
  on public.user_storage (user_id, updated_at, key);

create or replace function public.sync_pull(
  p_since     timestamptz,
  p_after_key text default '',
  p_limit     integer default 500
)
returns table (key text, value jsonb, updated_at timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select s.key, s.value, s.updated_at
  from public.user_storage s
  where s.user_id = auth.uid()
    and (s.updated_at, s.key) > (p_since, coalesce(p_after_key, ''))
  order by s.updated_at, s.key
  limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

revoke execute on function public.sync_pull(timestamptz, text, integer) from public, anon;
grant  execute on function public.sync_pull(timestamptz, text, integer) to authenticated;


-- ─── 2. Quota de stockage corrigé ───────────────────────────────────────────
-- Avant : count(*) >= 1000 bloquait aussi les UPDATE d'une clé existante, et
-- l'ancienne taille de la ligne était comptée deux fois. Avec une clé par séance,
-- 1 000 clés ne suffisent plus.

create or replace function public.check_user_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_max_keys  constant integer := 20000;
  v_max_bytes constant bigint  := 50 * 1024 * 1024;
  v_count     integer;
  v_total     bigint;
  v_old_size  bigint;
  v_exists    boolean;
begin
  select octet_length(value::text) into v_old_size
  from public.user_storage
  where user_id = new.user_id and key = new.key;
  v_exists := found;

  select count(*), coalesce(sum(octet_length(value::text)), 0)
  into v_count, v_total
  from public.user_storage
  where user_id = new.user_id;

  if not v_exists and v_count >= v_max_keys then
    raise exception 'Quota dépassé : max % clés', v_max_keys using errcode = 'P0001';
  end if;

  if v_total - coalesce(v_old_size, 0) + octet_length(new.value::text) > v_max_bytes then
    raise exception 'Quota dépassé : max 50MB' using errcode = 'P0002';
  end if;

  return new;
end;
$$;


-- ─── 3. Droits Pro côté serveur ─────────────────────────────────────────────
-- Le client peut LIRE son plan, jamais l'écrire. Seul le service_role
-- (futur webhook Stripe, trigger d'inscription) modifie cette table.

create table if not exists public.entitlements (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  tier          text not null default 'free' check (tier in ('free', 'pro')),
  pro_until     timestamptz,
  trial_ends_at timestamptz default (now() + interval '7 days'),
  updated_at    timestamptz not null default now()
);

alter table public.entitlements enable row level security;
alter table public.entitlements force row level security;

drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own"
  on public.entitlements
  for select
  using (auth.uid() = user_id);

revoke all    on public.entitlements from anon, authenticated;
grant  select on public.entitlements to authenticated;

drop trigger if exists entitlements_updated_at on public.entitlements;
create trigger entitlements_updated_at
  before update on public.entitlements
  for each row
  execute function public.set_updated_at();

create or replace function public.create_entitlement_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.entitlements (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_entitlement on auth.users;
create trigger on_auth_user_created_entitlement
  after insert on auth.users
  for each row
  execute function public.create_entitlement_for_new_user();

-- Utilisateurs existants : essai de 7 jours à partir de l'application de la migration.
insert into public.entitlements (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Helper serveur réutilisable (Edge Functions, futures policies).
create or replace function public.is_pro(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and (
        (e.tier = 'pro' and (e.pro_until is null or e.pro_until > now()))
        or (e.trial_ends_at is not null and e.trial_ends_at > now())
      )
  );
$$;

revoke execute on function public.is_pro(uuid) from public, anon, authenticated;


-- ─── 4. Quota coach IA atomique ─────────────────────────────────────────────
-- Verrou consultatif par utilisateur : N requêtes parallèles ne peuvent plus
-- toutes passer le « compter puis insérer ». Réservé au service_role.

create or replace function public.consume_ai_coach_quota(
  p_user        uuid,
  p_limit       integer default 10,
  p_prompt_chars integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('ai_coach:' || p_user::text));

  select count(*) into v_count
  from public.ai_coach_usage
  where user_id = p_user
    and requested_at > now() - interval '1 hour';

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.ai_coach_usage (user_id, requested_at, prompt_chars)
  values (p_user, now(), greatest(coalesce(p_prompt_chars, 0), 0));

  return true;
end;
$$;

revoke execute on function public.consume_ai_coach_quota(uuid, integer, integer)
  from public, anon, authenticated;


-- ─── 5. Keep-alive ──────────────────────────────────────────────────────────
-- Requête minimale qui touche Postgres. Appelée par .github/workflows/supabase-keep-alive.yml
-- pour éviter la mise en pause des projets Free inactifs (portfolio / démo).

create or replace function public.keep_alive()
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select 'ok:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

grant execute on function public.keep_alive() to anon, authenticated;
