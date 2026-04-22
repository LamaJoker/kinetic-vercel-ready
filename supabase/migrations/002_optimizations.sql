-- supabase/migrations/002_optimizations.sql
-- Optimisations production : index, RLS strict, quota, delta sync

-- ─── Index supplémentaires ────────────────────────────────────

-- Index composite covering (évite les heap fetches)
create index concurrently if not exists idx_user_storage_user_key
  on public.user_storage (user_id, key)
  include (value, updated_at);

-- Index pour sync delta : "tout ce qui a changé depuis X"
create index concurrently if not exists idx_user_storage_updated
  on public.user_storage (user_id, updated_at desc);

-- Index sur profiles pour les lookups email
create index concurrently if not exists idx_profiles_email
  on public.profiles (email)
  where email is not null;

-- ─── RLS strict — remplace les politiques permissives ────────

-- Supprimer les anciennes politiques
drop policy if exists "Users manage own storage"  on public.user_storage;
drop policy if exists "Users read own profile"    on public.profiles;
drop policy if exists "Users update own profile"  on public.profiles;

-- user_storage : SELECT
create policy "storage_select_own"
  on public.user_storage
  for select
  using (auth.uid() = user_id);

-- user_storage : INSERT avec validation
create policy "storage_insert_own"
  on public.user_storage
  for insert
  with check (
    auth.uid() = user_id
    and length(key) > 0
    and length(key) <= 200
    and key ~ '^[a-zA-Z0-9:_-]+$'
    and octet_length(value::text) <= 1048576
  );

-- user_storage : UPDATE avec validation
create policy "storage_update_own"
  on public.user_storage
  for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and octet_length(value::text) <= 1048576
  );

-- user_storage : DELETE
create policy "storage_delete_own"
  on public.user_storage
  for delete
  using (auth.uid() = user_id);

-- profiles : SELECT
create policy "profiles_select_own"
  on public.profiles
  for select
  using (auth.uid() = id);

-- profiles : UPDATE avec contraintes
create policy "profiles_update_own"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and (full_name is null or length(full_name) <= 100)
    and (avatar_url is null or avatar_url ~ '^https://')
  );

-- ─── Quota par utilisateur ────────────────────────────────────

create or replace function public.check_user_storage_quota()
returns trigger
language plpgsql
security definer
as $$
declare
  v_count      integer;
  v_total_size bigint;
  v_max_keys   constant integer := 1000;
  v_max_bytes  constant bigint  := 50 * 1024 * 1024; -- 50MB
begin
  select
    count(*),
    coalesce(sum(octet_length(value::text)), 0)
  into v_count, v_total_size
  from public.user_storage
  where user_id = new.user_id;

  if v_count >= v_max_keys then
    raise exception 'Quota dépassé : max % clés', v_max_keys
      using errcode = 'P0001';
  end if;

  if v_total_size >= v_max_bytes then
    raise exception 'Quota dépassé : max 50MB'
      using errcode = 'P0002';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_storage_quota on public.user_storage;
create trigger enforce_storage_quota
  before insert on public.user_storage
  for each row
  execute function public.check_user_storage_quota();

-- ─── Vue delta sync ───────────────────────────────────────────

create or replace view public.user_storage_delta as
select
  user_id,
  key,
  value,
  updated_at,
  extract(epoch from updated_at) as updated_epoch
from public.user_storage
where user_id = auth.uid();

-- ─── Fonction RPC : get_changes_since ────────────────────────

create or replace function public.get_changes_since(
  p_since timestamptz
)
returns table (
  key        text,
  value      jsonb,
  updated_at timestamptz
)
language sql
security definer
stable
as $$
  select
    key,
    value,
    updated_at
  from public.user_storage
  where
    user_id    = auth.uid()
    and updated_at > p_since
  order by updated_at asc;
$$;

grant execute on function public.get_changes_since to authenticated;
