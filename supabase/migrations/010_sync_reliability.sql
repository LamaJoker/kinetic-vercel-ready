-- ============================================================================
-- Migration 010 : synchronisation fiable (tombstones, écriture conditionnelle,
--                 version serveur, quota incrémental, purge + resync)
-- ============================================================================
-- Référence fonctionnelle : docs/architecture/sync.md
--
--  1. user_storage.deleted / deleted_at      tombstones synchronisées (F1, SEC-02)
--  2. index                                  suppression de INCLUDE(value) et du doublon
--                                            (SEC-01, PERF-01, PERF-04)
--  3. user_storage_usage / sync_meta         compteur de quota O(1), horizon de purge
--  4. triggers                               version = horloge SERVEUR, monotone par
--                                            utilisateur, sous verrou par utilisateur
--                                            (F11, F13, SEC-10) ; DELETE client → tombstone ;
--                                            quota incrémental (F12, SEC-05, PERF-03)
--  5. sync_push(p_items)                     écriture conditionnelle par lots (F9)
--  6. sync_pull_v2(...)                      pull paginé avec tombstones + resync_required
--  7. sync_delete_all()                      « supprimer toutes mes données cloud » (F5)
--  8. purge_sync_tombstones(older_than)      purge (service_role / pg_cron)
--  9. compatibilité                          sync_pull, get_changes_since, user_storage_delta
--                                            masquent les tombstones aux anciens clients
--
-- NON DESTRUCTIVE : aucune colonne ni table de données supprimée. Seuls deux index
-- et deux triggers remplacés sont supprimés.
-- IDEMPOTENTE : peut être rejouée sans erreur (testé par scripts/test-sql.sh).
-- Gros volumes : les DROP INDEX peuvent être faits au préalable hors transaction avec
-- `drop index concurrently if exists ...` ; ils deviennent alors des no-op ici.
-- ============================================================================


-- ─── 0. Pré-requis ──────────────────────────────────────────────────────────
-- Les fonctions SECURITY DEFINER de purge et de recalcul du quota lisent toutes
-- les lignes malgré FORCE ROW LEVEL SECURITY : leur propriétaire (le rôle qui
-- applique la migration, `postgres` sur Supabase) doit avoir BYPASSRLS.
do $$
begin
  if not exists (
    select 1 from pg_roles
    where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception 'Migration 010 : le rôle % doit avoir BYPASSRLS (ou être superuser)', current_user;
  end if;
end
$$;


-- ─── 1. Colonnes de tombstone ───────────────────────────────────────────────
-- Ajout avec valeur par défaut constante : pas de réécriture de table (PG ≥ 11).

alter table public.user_storage add column if not exists deleted    boolean not null default false;
alter table public.user_storage add column if not exists deleted_at timestamptz;

-- Forme stricte d'une tombstone : value = JSON null, deleted_at renseigné.
-- Une ligne VIVANTE peut valoir JSON null (« valeur null ») : seule la colonne
-- deleted dit si la clé est supprimée.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_storage_tombstone_shape'
      and conrelid = 'public.user_storage'::regclass
  ) then
    alter table public.user_storage
      add constraint user_storage_tombstone_shape check (
        (deleted and value = 'null'::jsonb and deleted_at is not null)
        or (not deleted and deleted_at is null)
      ) not valid;
  end if;
end
$$;

alter table public.user_storage validate constraint user_storage_tombstone_shape;


-- ─── 2. Index ───────────────────────────────────────────────────────────────
-- idx_user_storage_user_key INCLUDE(value, updated_at) : une entrée d'index B-tree
-- est limitée à 2 704 octets, toute valeur de plus de ~2,7 Ko compressés était
-- REJETÉE (séances longues, pesées sur un an, photos). La clé primaire
-- (user_id, key) couvre déjà toutes les recherches par clé.
drop index if exists public.idx_user_storage_user_key;
-- (user_id, updated_at desc) : redondant avec idx_user_storage_user_updated_key.
drop index if exists public.idx_user_storage_updated;

-- Index du pull keyset (créé par 009, recréé ici si absent).
create index if not exists idx_user_storage_user_updated_key
  on public.user_storage (user_id, updated_at, key);

-- Purge des tombstones : index partiel, minuscule.
create index if not exists idx_user_storage_tombstones
  on public.user_storage (updated_at)
  where deleted;


-- ─── 3. Tables de service ───────────────────────────────────────────────────

-- Compteur de quota par utilisateur + dernière version émise (verrou par utilisateur).
create table if not exists public.user_storage_usage (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  keys         integer     not null default 0,  -- lignes VIVANTES (tombstones exclues)
  bytes        bigint      not null default 0,  -- somme de octet_length(value::text) des lignes vivantes
  last_version timestamptz,                     -- plus grand updated_at émis pour cet utilisateur
  updated_at   timestamptz not null default now()
);

alter table public.user_storage_usage enable row level security;

drop policy if exists "usage_select_own" on public.user_storage_usage;
create policy "usage_select_own"
  on public.user_storage_usage
  for select
  using (auth.uid() = user_id);

revoke all    on public.user_storage_usage from anon, authenticated;
grant  select on public.user_storage_usage to authenticated;
grant  all    on public.user_storage_usage to service_role;

-- Méta-données globales de synchro (une seule ligne).
create table if not exists public.sync_meta (
  id                smallint primary key default 1 check (id = 1),
  tombstone_horizon timestamptz,          -- tombstones antérieures possiblement purgées
  last_purge_at     timestamptz,
  last_purge_count  bigint not null default 0
);

insert into public.sync_meta (id) values (1) on conflict (id) do nothing;

alter table public.sync_meta enable row level security;

drop policy if exists "sync_meta_read" on public.sync_meta;
create policy "sync_meta_read"
  on public.sync_meta
  for select
  to authenticated
  using (true);

revoke all    on public.sync_meta from anon, authenticated;
grant  select on public.sync_meta to authenticated;
grant  all    on public.sync_meta to service_role;


-- ─── 4. Limites ─────────────────────────────────────────────────────────────

create or replace function public.user_storage_max_keys()
returns integer language sql immutable set search_path = public, pg_temp
as $$ select 20000 $$;

create or replace function public.user_storage_max_bytes()
returns bigint language sql immutable set search_path = public, pg_temp
as $$ select 50::bigint * 1024 * 1024 $$;

create or replace function public.user_storage_max_value_bytes()
returns integer language sql immutable set search_path = public, pg_temp
as $$ select 1048576 $$;


-- ─── 5. Verrou par utilisateur ──────────────────────────────────────────────
-- Toute écriture dans user_storage prend d'abord le verrou de la ligne
-- user_storage_usage de l'utilisateur, PUIS reçoit sa version. Conséquence :
-- pour un même utilisateur, une ligne visible a toujours une version inférieure
-- à celle de toute écriture non encore validée. Un curseur de pull ne peut donc
-- jamais dépasser une transaction en cours (F11), et le quota n'a plus de course.

create or replace function public.user_storage_lock_user(p_user uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
begin
  select u.last_version into v_last
  from public.user_storage_usage u
  where u.user_id = p_user
  for update;

  if not found then
    insert into public.user_storage_usage (user_id) values (p_user)
    on conflict (user_id) do nothing;
    select u.last_version into v_last
    from public.user_storage_usage u
    where u.user_id = p_user
    for update;
  end if;

  return v_last;
end;
$$;

revoke execute on function public.user_storage_lock_user(uuid) from public, anon, authenticated;

-- Variante appelable par le client (sync_push, SECURITY INVOKER) : uniquement son propre verrou.
create or replace function public.sync_lock_self()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sync: non authentifié' using errcode = '42501';
  end if;
  perform public.user_storage_lock_user(auth.uid());
end;
$$;

revoke execute on function public.sync_lock_self() from public, anon;
grant  execute on function public.sync_lock_self() to authenticated;


-- ─── 6. Triggers de user_storage ────────────────────────────────────────────

-- 6a. BEFORE INSERT OR UPDATE : version serveur, created_at, forme des tombstones.
create or replace function public.user_storage_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_ts   timestamptz;
begin
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.key is distinct from old.key) then
    raise exception 'user_storage: user_id et key sont immuables' using errcode = '22023';
  end if;

  v_last := public.user_storage_lock_user(new.user_id);

  -- Version = horloge serveur, strictement croissante par utilisateur et par ligne.
  -- Le client ne peut PAS la fixer (F13 / SEC-10) : toute valeur envoyée est ignorée.
  v_ts := clock_timestamp();
  if v_last is not null and v_ts <= v_last then
    v_ts := v_last + interval '1 microsecond';
  end if;
  if tg_op = 'UPDATE' and v_ts <= old.updated_at then
    v_ts := old.updated_at + interval '1 microsecond';
  end if;
  new.updated_at := v_ts;

  if tg_op = 'INSERT' then
    new.created_at := v_ts;
  else
    new.created_at := old.created_at;
    -- Ancien client (upsert direct qui ignore la colonne deleted) écrivant une
    -- nouvelle valeur sur une tombstone : c'est une recréation.
    if old.deleted and new.deleted and new.value is distinct from old.value then
      new.deleted := false;
    end if;
  end if;

  if new.deleted then
    new.value      := 'null'::jsonb;
    new.deleted_at := v_ts;
  else
    new.deleted_at := null;
  end if;

  update public.user_storage_usage
  set last_version = v_ts
  where user_id = new.user_id;

  return new;
end;
$$;

revoke execute on function public.user_storage_before_write() from public, anon, authenticated;

-- 6b. BEFORE DELETE : un DELETE envoyé par un client (ancienne version de l'app,
-- SupabaseStorage.remove/clear) devient une tombstone, propagée aux autres
-- appareils. Les suppressions physiques restent possibles pour le propriétaire
-- de la table (purge), le service_role et les cascades (suppression de compte).
create or replace function public.user_storage_delete_as_tombstone()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' and pg_trigger_depth() = 1 then
    if not old.deleted then
      update public.user_storage
      set deleted = true
      where user_id = old.user_id and key = old.key;
    end if;
    return null; -- la ligne reste, sous forme de tombstone
  end if;
  return old;
end;
$$;

revoke execute on function public.user_storage_delete_as_tombstone() from public, anon, authenticated;

-- 6c. AFTER INSERT/UPDATE/DELETE : compteur incrémental O(1) + contrôle du quota.
-- AFTER (et non BEFORE) car un upsert déclenche BEFORE INSERT puis BEFORE UPDATE :
-- seuls les triggers AFTER reflètent ce qui a réellement été écrit.
create or replace function public.user_storage_after_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid;
  d_keys    integer := 0;
  d_bytes   bigint  := 0;
  v_keys    integer;
  v_bytes   bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') and not old.deleted then
    d_keys  := d_keys - 1;
    d_bytes := d_bytes - octet_length(old.value::text);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not new.deleted then
    d_keys  := d_keys + 1;
    d_bytes := d_bytes + octet_length(new.value::text);
  end if;

  if d_keys = 0 and d_bytes = 0 then
    return null;
  end if;

  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;

  update public.user_storage_usage
  set keys       = greatest(keys + d_keys, 0),
      bytes      = greatest(bytes + d_bytes, 0),
      updated_at = now()
  where user_id = v_user
  returning keys, bytes into v_keys, v_bytes;

  -- Seules les hausses sont contrôlées : un compte au-delà du quota peut toujours
  -- supprimer ou réduire ses données.
  if tg_op <> 'DELETE' and v_keys is not null then
    if d_keys > 0 and v_keys > public.user_storage_max_keys() then
      raise exception 'Quota dépassé : max % clés', public.user_storage_max_keys()
        using errcode = 'P0001';
    end if;
    if d_bytes > 0 and v_bytes > public.user_storage_max_bytes() then
      raise exception 'Quota dépassé : max 50MB' using errcode = 'P0002';
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function public.user_storage_after_write() from public, anon, authenticated;

-- Remplacement des anciens triggers :
--  - user_storage_updated_at (BEFORE UPDATE → now()) écraserait la version monotone ;
--  - enforce_storage_quota relisait tout le stockage de l'utilisateur à chaque écriture.
drop trigger if exists user_storage_updated_at on public.user_storage;
drop trigger if exists enforce_storage_quota  on public.user_storage;

-- Correction des versions dans le futur (un ancien client pouvait fixer updated_at
-- à l'INSERT) : ramenées à l'heure actuelle. Faite AVANT les nouveaux triggers,
-- sans les déclencher. Transformation de méta-données uniquement.
update public.user_storage
set updated_at = now()
where updated_at > now() + interval '1 minute';

create or replace trigger user_storage_10_before_write
  before insert or update on public.user_storage
  for each row
  execute function public.user_storage_before_write();

create or replace trigger user_storage_05_delete_as_tombstone
  before delete on public.user_storage
  for each row
  execute function public.user_storage_delete_as_tombstone();

create or replace trigger user_storage_90_after_write
  after insert or update or delete on public.user_storage
  for each row
  execute function public.user_storage_after_write();


-- ─── 7. Initialisation / recalcul du compteur ───────────────────────────────

create or replace function public.recompute_user_storage_usage(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  insert into public.user_storage_usage as u (user_id, keys, bytes, last_version, updated_at)
  select s.user_id,
         (count(*) filter (where not s.deleted))::integer,
         coalesce(sum(octet_length(s.value::text)) filter (where not s.deleted), 0),
         max(s.updated_at),
         now()
  from public.user_storage s
  where p_user is null or s.user_id = p_user
  group by s.user_id
  on conflict (user_id) do update
    set keys         = excluded.keys,
        bytes        = excluded.bytes,
        last_version = greatest(coalesce(u.last_version, excluded.last_version), excluded.last_version),
        updated_at   = now();
  get diagnostics v_n = row_count;

  -- Utilisateurs sans aucune ligne : compteur à zéro.
  update public.user_storage_usage u
  set keys = 0, bytes = 0, updated_at = now()
  where (p_user is null or u.user_id = p_user)
    and (u.keys <> 0 or u.bytes <> 0)
    and not exists (select 1 from public.user_storage s where s.user_id = u.user_id);

  return v_n;
end;
$$;

revoke execute on function public.recompute_user_storage_usage(uuid) from public, anon, authenticated;
grant  execute on function public.recompute_user_storage_usage(uuid) to service_role;

-- Initialisation depuis l'existant, écritures bloquées le temps du calcul
-- (verrou levé à la fin de la transaction de migration).
lock table public.user_storage in share row exclusive mode;
select public.recompute_user_storage_usage(null);


-- ─── 8. sync_push : écriture conditionnelle par lots ────────────────────────
-- p_items : [{ "key": text, "value"?: json, "deleted"?: bool, "base": timestamptz|null }]
-- Résultat : tableau aligné sur p_items, un objet par élément :
--   { key, status: 'ok'|'conflict'|'rejected'|'deferred', updated_at, deleted?,
--     server_value?, server_deleted?, server_value_omitted?, reason? }
-- Un élément en erreur n'interrompt jamais le lot (sous-transaction par élément).

create or replace function public.sync_push(p_items jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  c_max_items         constant integer := 100;
  c_max_batch_bytes   constant bigint  := 4 * 1048576;
  c_max_reply_bytes   constant bigint  := 4 * 1048576;
  v_uid          uuid := auth.uid();
  v_item         jsonb;
  v_idx          integer := 0;
  v_key          text;
  v_value        jsonb;
  v_deleted      boolean;
  v_base         timestamptz;
  v_size         bigint;
  v_batch_bytes  bigint := 0;
  v_reply_bytes  bigint := 0;
  v_seen         text[] := '{}';
  v_cur_ts       timestamptz;
  v_cur_deleted  boolean;
  v_cur_value    jsonb;
  v_new_ts       timestamptz;
  v_res          jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_state        text;
  v_constraint   text;
begin
  if v_uid is null then
    raise exception 'sync_push: non authentifié' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'sync_push: p_items doit être un tableau JSON' using errcode = '22023';
  end if;

  -- Verrou utilisateur pris AVANT tout verrou de ligne : deux lots concurrents
  -- du même compte sont sérialisés, sans interblocage.
  perform public.sync_lock_self();

  for v_item in select e.value from jsonb_array_elements(p_items) as e(value) loop
    v_idx := v_idx + 1;
    v_key := case
      when jsonb_typeof(v_item) = 'object' and jsonb_typeof(v_item -> 'key') = 'string'
      then v_item ->> 'key'
    end;
    v_res := jsonb_build_object('key', v_key);

    -- Lot trop long : le reste est renvoyé, à pousser dans un lot suivant.
    if v_idx > c_max_items then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'deferred', 'reason', 'batch_limit', 'updated_at', null));
      continue;
    end if;

    if v_key is null
       or (v_item ? 'deleted' and jsonb_typeof(v_item -> 'deleted') not in ('boolean', 'null'))
       or (v_item ? 'base' and jsonb_typeof(v_item -> 'base') not in ('string', 'null')) then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'invalid_item', 'updated_at', null));
      continue;
    end if;

    if v_key !~ '^[a-zA-Z0-9:_-]{1,200}$' then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'invalid_key', 'updated_at', null));
      continue;
    end if;

    if v_key = any (v_seen) then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'duplicate_key', 'updated_at', null));
      continue;
    end if;
    v_seen := v_seen || v_key;

    v_deleted := coalesce((v_item ->> 'deleted')::boolean, false);
    if not v_deleted and not (v_item ? 'value') then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'missing_value', 'updated_at', null));
      continue;
    end if;
    v_value := case when v_deleted then 'null'::jsonb else v_item -> 'value' end;

    begin
      v_base := (v_item ->> 'base')::timestamptz;
    exception when others then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'invalid_base', 'updated_at', null));
      continue;
    end;

    v_size := octet_length(v_value::text);
    if v_size > public.user_storage_max_value_bytes() then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'rejected', 'reason', 'value_too_large', 'updated_at', null));
      continue;
    end if;
    if v_batch_bytes > 0 and v_batch_bytes + v_size > c_max_batch_bytes then
      v_results := v_results || jsonb_build_array(
        v_res || jsonb_build_object('status', 'deferred', 'reason', 'batch_limit', 'updated_at', null));
      continue;
    end if;
    v_batch_bytes := v_batch_bytes + v_size;

    begin -- sous-transaction : une erreur n'annule que cet élément
      select s.updated_at, s.deleted, s.value
      into v_cur_ts, v_cur_deleted, v_cur_value
      from public.user_storage s
      where s.user_id = v_uid and s.key = v_key
      for update;

      if found and (v_base is null or v_cur_ts > v_base) then
        if v_cur_deleted = v_deleted and (v_deleted or v_cur_value = v_value) then
          -- Même état déjà présent (réessai après réponse perdue, ou valeur identique) :
          -- succès idempotent, sans nouvelle version.
          v_res := v_res || jsonb_build_object(
            'status', 'ok', 'updated_at', v_cur_ts, 'deleted', v_cur_deleted);
        else
          v_res := v_res || jsonb_build_object(
            'status', 'conflict', 'updated_at', v_cur_ts, 'server_deleted', v_cur_deleted);
          if not v_cur_deleted then
            v_size := octet_length(v_cur_value::text);
            if v_reply_bytes + v_size <= c_max_reply_bytes then
              v_res := v_res || jsonb_build_object('server_value', v_cur_value);
              v_reply_bytes := v_reply_bytes + v_size;
            else
              v_res := v_res || jsonb_build_object('server_value_omitted', true);
            end if;
          end if;
        end if;
      elsif found then
        update public.user_storage
        set value = v_value, deleted = v_deleted
        where user_id = v_uid and key = v_key
        returning updated_at into v_new_ts;
        v_res := v_res || jsonb_build_object('status', 'ok', 'updated_at', v_new_ts, 'deleted', v_deleted);
      else
        -- Clé absente (jamais créée, ou tombstone purgée) : création, y compris
        -- d'une tombstone pour informer les appareils qui auraient encore la clé.
        insert into public.user_storage (user_id, key, value, deleted)
        values (v_uid, v_key, v_value, v_deleted)
        returning updated_at into v_new_ts;
        v_res := v_res || jsonb_build_object('status', 'ok', 'updated_at', v_new_ts, 'deleted', v_deleted);
      end if;
    exception
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
        v_res := v_res || jsonb_build_object('updated_at', null) || case
          when v_state = 'P0001' then jsonb_build_object('status', 'rejected', 'reason', 'quota_keys')
          when v_state = 'P0002' then jsonb_build_object('status', 'rejected', 'reason', 'quota_bytes')
          when v_state = '23514' and v_constraint = 'key_format'
            then jsonb_build_object('status', 'rejected', 'reason', 'invalid_key')
          when v_state in ('23514', '54000')
            then jsonb_build_object('status', 'rejected', 'reason', 'value_too_large')
          when v_state = '42501' then jsonb_build_object('status', 'rejected', 'reason', 'forbidden')
          when v_state in ('40001', '40P01', '55P03', '23505') or v_state like '53%'
            then jsonb_build_object('status', 'deferred', 'reason', 'transient:' || v_state)
          else jsonb_build_object('status', 'rejected', 'reason', 'internal:' || v_state)
        end;
    end;

    v_results := v_results || jsonb_build_array(v_res);
  end loop;

  return v_results;
end;
$$;

revoke execute on function public.sync_push(jsonb) from public, anon;
grant  execute on function public.sync_push(jsonb) to authenticated;


-- ─── 9. sync_pull_v2 : pull paginé avec tombstones ──────────────────────────
-- Changements strictement après (p_since, p_after_key), triés par (updated_at, key).
-- p_since null ou ≤ 1970-01-01 : pull complet (jamais de resync_required).
-- Résultat : { changes: [{key, value, deleted, updated_at}], has_more,
--              resync_required, reason?, horizon, server_time }

create or replace function public.sync_pull_v2(
  p_since     timestamptz default null,
  p_after_key text        default '',
  p_limit     integer     default 500
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_max_reply_bytes constant bigint := 4 * 1048576;
  v_uid      uuid := auth.uid();
  v_now      timestamptz := clock_timestamp();
  v_horizon  timestamptz;
  v_full     boolean := p_since is null or p_since <= timestamptz '1970-01-01 00:00:00+00';
  v_since    timestamptz := coalesce(p_since, '-infinity'::timestamptz);
  v_limit    integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_changes  jsonb := '[]'::jsonb;
  v_count    integer := 0;
  v_bytes    bigint := 0;
  v_size     bigint;
  v_has_more boolean := false;
  r          record;
begin
  if v_uid is null then
    raise exception 'sync_pull_v2: non authentifié' using errcode = '42501';
  end if;

  select m.tombstone_horizon into v_horizon from public.sync_meta m where m.id = 1;

  if not v_full and v_horizon is not null and p_since < v_horizon then
    return jsonb_build_object(
      'changes', '[]'::jsonb, 'has_more', false, 'resync_required', true,
      'reason', 'tombstones_purged', 'horizon', v_horizon, 'server_time', v_now);
  end if;
  if not v_full and p_since > v_now + interval '1 minute' then
    return jsonb_build_object(
      'changes', '[]'::jsonb, 'has_more', false, 'resync_required', true,
      'reason', 'cursor_in_future', 'horizon', v_horizon, 'server_time', v_now);
  end if;

  for r in
    select s.key, s.value, s.deleted, s.updated_at
    from public.user_storage s
    where s.user_id = v_uid
      and (s.updated_at, s.key) > (v_since, coalesce(p_after_key, ''))
    order by s.updated_at, s.key
    limit v_limit + 1
  loop
    if v_count >= v_limit then
      v_has_more := true;
      exit;
    end if;
    v_size := octet_length(r.value::text);
    if v_count > 0 and v_bytes + v_size > c_max_reply_bytes then
      v_has_more := true;
      exit;
    end if;
    v_changes := v_changes || jsonb_build_array(jsonb_build_object(
      'key', r.key, 'value', r.value, 'deleted', r.deleted, 'updated_at', r.updated_at));
    v_count := v_count + 1;
    v_bytes := v_bytes + v_size;
  end loop;

  return jsonb_build_object(
    'changes', v_changes, 'has_more', v_has_more, 'resync_required', false,
    'horizon', v_horizon, 'server_time', v_now);
end;
$$;

revoke execute on function public.sync_pull_v2(timestamptz, text, integer) from public, anon;
grant  execute on function public.sync_pull_v2(timestamptz, text, integer) to authenticated;


-- ─── 10. sync_delete_all : « supprimer toutes mes données cloud » ───────────
-- Une tombstone par clé vivante, en une requête. Les autres appareils les reçoivent
-- par sync_pull_v2. Renvoie { deleted_count, updated_at } (dernière version émise).

create or replace function public.sync_delete_all()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_n    integer;
  v_last timestamptz;
begin
  if v_uid is null then
    raise exception 'sync_delete_all: non authentifié' using errcode = '42501';
  end if;
  perform public.sync_lock_self();

  update public.user_storage
  set deleted = true
  where user_id = v_uid and not deleted;
  get diagnostics v_n = row_count;

  select max(s.updated_at) into v_last from public.user_storage s where s.user_id = v_uid;
  return jsonb_build_object('deleted_count', v_n, 'updated_at', v_last);
end;
$$;

revoke execute on function public.sync_delete_all() from public, anon;
grant  execute on function public.sync_delete_all() to authenticated;


-- ─── 11. sync_usage : quota consommé (affichage) ────────────────────────────

create or replace function public.sync_usage()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'keys',      coalesce((select u.keys  from public.user_storage_usage u where u.user_id = auth.uid()), 0),
    'bytes',     coalesce((select u.bytes from public.user_storage_usage u where u.user_id = auth.uid()), 0),
    'max_keys',  public.user_storage_max_keys(),
    'max_bytes', public.user_storage_max_bytes(),
    'max_value_bytes', public.user_storage_max_value_bytes()
  );
$$;

revoke execute on function public.sync_usage() from public, anon;
grant  execute on function public.sync_usage() to authenticated;


-- ─── 12. Purge des tombstones ───────────────────────────────────────────────
-- L'horizon est enregistré AVANT la suppression, dans la même transaction, et
-- ne recule jamais : sync_pull_v2 signale resync_required à tout curseur antérieur.

create or replace function public.purge_sync_tombstones(older_than interval default interval '180 days')
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_horizon timestamptz;
  v_n       bigint;
begin
  if older_than is null or older_than < interval '1 day' then
    raise exception 'purge_sync_tombstones: older_than doit être ≥ 1 jour' using errcode = '22023';
  end if;

  update public.sync_meta
  set tombstone_horizon = greatest(coalesce(tombstone_horizon, '-infinity'::timestamptz), now() - older_than),
      last_purge_at     = now()
  where id = 1
  returning tombstone_horizon into v_horizon;

  delete from public.user_storage
  where deleted and updated_at < v_horizon;
  get diagnostics v_n = row_count;

  update public.sync_meta set last_purge_count = v_n where id = 1;
  return v_n;
end;
$$;

revoke execute on function public.purge_sync_tombstones(interval) from public, anon, authenticated;
grant  execute on function public.purge_sync_tombstones(interval) to service_role;

-- Planification hebdomadaire si pg_cron est installé (sinon : à appeler par un job externe).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$
      select cron.schedule('kinetic-purge-sync-tombstones', '17 3 * * 0',
                           'select public.purge_sync_tombstones()')
    $cron$;
  end if;
exception when others then
  raise notice 'pg_cron : planification de la purge ignorée (%)', sqlerrm;
end
$$;


-- ─── 13. Compatibilité anciens clients ──────────────────────────────────────
-- Les anciennes lectures ne voient jamais de tombstone (elles les prendraient
-- pour une valeur JSON null).

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
    and not s.deleted
    and (s.updated_at, s.key) > (p_since, coalesce(p_after_key, ''))
  order by s.updated_at, s.key
  limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$$;

revoke execute on function public.sync_pull(timestamptz, text, integer) from public, anon;
grant  execute on function public.sync_pull(timestamptz, text, integer) to authenticated;

create or replace function public.get_changes_since(p_since timestamptz)
returns table (key text, value jsonb, updated_at timestamptz)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select s.key, s.value, s.updated_at
  from public.user_storage s
  where s.user_id = auth.uid() and not s.deleted and s.updated_at > p_since
  order by s.updated_at asc;
$$;

create or replace view public.user_storage_delta
with (security_invoker = true) as
select
  user_id,
  key,
  value,
  updated_at,
  extract(epoch from updated_at) as updated_epoch
from public.user_storage
where user_id = auth.uid()
  and not deleted;
