-- supabase/migrations/003_security_hardening.sql
-- ══════════════════════════════════════════════════════════════
-- Durcissement sécurité : search_path, vues SECURITY INVOKER,
-- rate limit anonyme sur vitals_metrics.
--
-- Appliquer avec : supabase db push
-- ══════════════════════════════════════════════════════════════

-- ─── 1. Verrouiller search_path sur toutes les SECURITY DEFINER ───
-- Sans `set search_path`, un utilisateur avec CREATE sur un schéma
-- dans son search_path peut injecter des fonctions homonymes et
-- détourner l'exécution. C'est LA vulnérabilité classique SECURITY
-- DEFINER de Postgres.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
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

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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
set search_path = public, pg_temp
as $$
begin
  -- Validation d'entrée stricte côté SQL (le client ne peut pas contourner)
  if p_xp_earned < 0 or p_xp_earned > 100000 then
    raise exception 'xp_earned hors borne (0-100000): %', p_xp_earned
      using errcode = 'P0001';
  end if;
  if p_tasks_done < 0 or p_tasks_done > 1000 then
    raise exception 'tasks_done hors borne (0-1000): %', p_tasks_done
      using errcode = 'P0001';
  end if;
  if p_streak_day < 0 or p_streak_day > 100000 then
    raise exception 'streak_day hors borne: %', p_streak_day
      using errcode = 'P0001';
  end if;
  if p_date > current_date + interval '1 day' or p_date < current_date - interval '90 days' then
    raise exception 'date hors fenêtre autorisée: %', p_date
      using errcode = 'P0001';
  end if;

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

create or replace function public.check_user_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count      integer;
  v_total_size bigint;
  v_max_keys   constant integer := 1000;
  v_max_bytes  constant bigint  := 50 * 1024 * 1024;
begin
  select
    count(*),
    coalesce(sum(octet_length(value::text)), 0)
  into v_count, v_total_size
  from public.user_storage
  where user_id = new.user_id;

  if v_count >= v_max_keys then
    raise exception 'Quota dépassé : max % clés', v_max_keys using errcode = 'P0001';
  end if;
  if v_total_size >= v_max_bytes then
    raise exception 'Quota dépassé : max 50MB' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

create or replace function public.get_changes_since(p_since timestamptz)
returns table (key text, value jsonb, updated_at timestamptz)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select key, value, updated_at
  from public.user_storage
  where user_id = auth.uid() and updated_at > p_since
  order by updated_at asc;
$$;

-- ─── 2. Vues en SECURITY INVOKER explicite (Postgres 15+) ────────
-- Par défaut, une vue tourne avec les privilèges de son créateur.
-- On veut qu'elle applique les RLS du caller (l'utilisateur courant).

alter view public.user_stats         set (security_invoker = true);
alter view public.user_storage_delta set (security_invoker = true);

-- ─── 3. Rate limit INSERT anonyme sur vitals_metrics ─────────────
-- La table accepte les insertions anon pour collecter les Web Vitals.
-- Sans limite, n'importe qui peut pourrir la table.
-- On limite à 60 insertions / IP / minute via une table d'accompagnement.

create table if not exists public.vitals_rate_limit (
  ip_hash    text        primary key,
  window_start timestamptz not null default now(),
  count      integer     not null default 0
);

-- Pas de RLS — gérée par le trigger seulement.

create or replace function public.check_vitals_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip_hash  text;
  v_window   timestamptz;
  v_count    integer;
  v_max      constant integer := 60;   -- 60 metrics / minute / IP
  v_window_s constant interval := interval '1 minute';
begin
  -- Hash de l'IP (si fournie par l'app), sinon fallback user_id ou random
  v_ip_hash := coalesce(
    encode(digest(current_setting('request.headers', true)::json->>'x-forwarded-for', 'sha256'), 'hex'),
    'unknown'
  );

  insert into public.vitals_rate_limit (ip_hash, window_start, count)
  values (v_ip_hash, now(), 1)
  on conflict (ip_hash) do update
  set
    window_start = case
      when now() - vitals_rate_limit.window_start > v_window_s then now()
      else vitals_rate_limit.window_start
    end,
    count = case
      when now() - vitals_rate_limit.window_start > v_window_s then 1
      else vitals_rate_limit.count + 1
    end
  returning count into v_count;

  if v_count > v_max then
    raise exception 'Rate limit exceeded for vitals_metrics' using errcode = 'P0003';
  end if;
  return new;
end;
$$;

-- pgcrypto fournit digest()
create extension if not exists "pgcrypto";

drop trigger if exists vitals_rate_limit_trigger on public.vitals_metrics;
create trigger vitals_rate_limit_trigger
  before insert on public.vitals_metrics
  for each row
  execute function public.check_vitals_rate_limit();

-- Purge périodique (à scheduler via pg_cron si disponible, sinon
-- le trigger lui-même écrase les vieilles entrées)
create index if not exists idx_vitals_rate_limit_window
  on public.vitals_rate_limit (window_start);

-- ─── 4. Révoquer les permissions trop larges ─────────────────────
-- `grant all on public.profiles` inclut DELETE et TRUNCATE : trop large.
-- On reserre explicitement.

revoke all on public.profiles        from authenticated;
revoke all on public.user_storage    from authenticated;
revoke all on public.daily_logs      from authenticated;

grant  select, update          on public.profiles     to authenticated;
grant  select, insert, update, delete on public.user_storage to authenticated;
grant  select, insert, update  on public.daily_logs   to authenticated;
-- (pas de DELETE sur daily_logs : les logs sont append-only pour l'intégrité historique)

-- ─── 5. Forcer RLS même pour les rôles "bypass" (defense in depth) ──
alter table public.profiles      force row level security;
alter table public.user_storage  force row level security;
alter table public.daily_logs    force row level security;
