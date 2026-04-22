-- supabase/migrations/001_initial.sql
-- ══════════════════════════════════════════════════════════════
-- Kinetic — Schéma initial
-- À appliquer via : supabase db push
-- ou SQL Editor dans le dashboard Supabase
-- ══════════════════════════════════════════════════════════════

-- ─── Extensions ──────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── Table : profiles ─────────────────────────────────────────
-- Profil utilisateur public (complète auth.users)
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  avatar_url  text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS
alter table public.profiles enable row level security;

-- Auto-créer le profil à l'inscription
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'avatar_url', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Auto-mettre à jour updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ─── Table : user_storage ─────────────────────────────────────
-- Clé-valeur JSONB généraliste — remplace localStorage côté serveur
create table if not exists public.user_storage (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null,
  value      jsonb       not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, key),
  constraint key_format check (key ~ '^[a-zA-Z0-9:_-]{1,200}$'),
  constraint value_size  check (octet_length(value::text) <= 1048576) -- 1MB
);

-- RLS
alter table public.user_storage enable row level security;

-- Trigger updated_at
create trigger user_storage_updated_at
  before update on public.user_storage
  for each row
  execute function public.set_updated_at();

-- ─── Table : daily_logs ───────────────────────────────────────
-- Log des activités journalières (pour analytics future)
create table if not exists public.daily_logs (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  date        date        not null,
  xp_earned   integer     not null default 0 check (xp_earned >= 0),
  tasks_done  integer     not null default 0 check (tasks_done >= 0),
  streak_day  integer     not null default 0 check (streak_day >= 0),
  metadata    jsonb,
  created_at  timestamptz not null default now(),

  unique (user_id, date)
);

-- RLS
alter table public.daily_logs enable row level security;

-- Politiques RLS — daily_logs
create policy "logs_select_own"
  on public.daily_logs for select
  using (auth.uid() = user_id);

create policy "logs_insert_own"
  on public.daily_logs for insert
  with check (auth.uid() = user_id);

create policy "logs_update_own"
  on public.daily_logs for update
  using (auth.uid() = user_id);

-- ─── Table : vitals_metrics ───────────────────────────────────
-- Web Vitals anonymisés (pas de PII)
create table if not exists public.vitals_metrics (
  id          bigserial   primary key,
  name        text        not null check (name in ('LCP','CLS','FID','INP','TTFB','FCP')),
  value       real        not null,
  rating      text        not null check (rating in ('good','needs-improvement','poor')),
  url_path    text,
  ts          timestamptz not null default now()
);

-- Pas de RLS — données anonymes, insertion publique avec anon key
-- À sécuriser côté Edge Function si nécessaire

-- Index pour les requêtes d'analyse
create index if not exists idx_vitals_name_ts on public.vitals_metrics (name, ts desc);
create index if not exists idx_vitals_rating  on public.vitals_metrics (rating, ts desc);

-- ─── Vue : user_stats ─────────────────────────────────────────
-- Vue agrégée pour le dashboard profil
create or replace view public.user_stats as
select
  user_id,
  coalesce(sum(xp_earned), 0)::integer  as total_xp,
  coalesce(sum(tasks_done), 0)::integer as total_tasks,
  coalesce(max(streak_day), 0)::integer as best_streak,
  count(*)::integer                     as active_days,
  min(date)                             as first_day,
  max(date)                             as last_day
from public.daily_logs
group by user_id;

-- ─── Fonction RPC : upsert_daily_log ─────────────────────────
-- Appelée depuis le client pour enregistrer l'activité du jour
create or replace function public.upsert_daily_log(
  p_date        date,
  p_xp_earned   integer,
  p_tasks_done  integer,
  p_streak_day  integer,
  p_metadata    jsonb default null
)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.daily_logs (user_id, date, xp_earned, tasks_done, streak_day, metadata)
  values (auth.uid(), p_date, p_xp_earned, p_tasks_done, p_streak_day, p_metadata)
  on conflict (user_id, date)
  do update set
    xp_earned  = greatest(excluded.xp_earned,  daily_logs.xp_earned),
    tasks_done = greatest(excluded.tasks_done, daily_logs.tasks_done),
    streak_day = excluded.streak_day,
    metadata   = coalesce(excluded.metadata, daily_logs.metadata);
end;
$$;

-- ─── Permissions ─────────────────────────────────────────────
-- Donner accès à l'anon key pour les vitals (anonymes)
grant insert on public.vitals_metrics to anon;
grant usage, select on sequence public.vitals_metrics_id_seq to anon;

-- Accès authentifié aux tables principales
grant all on public.profiles        to authenticated;
grant all on public.user_storage    to authenticated;
grant all on public.daily_logs      to authenticated;
grant select on public.user_stats   to authenticated;
grant execute on function public.upsert_daily_log to authenticated;
