-- ============================================================================
-- Migration 007 : Web Push Subscriptions
-- ============================================================================
-- Table de stockage des subscriptions PushManager pour permettre l'envoi de
-- notifications push depuis l'Edge Function `send-push`.
--
-- Une subscription = un endpoint unique (URL fournie par le service worker
-- du navigateur). Un même utilisateur peut avoir plusieurs subscriptions
-- (multi-device : téléphone, desktop, tablette).
-- ============================================================================

create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Lecture : un user voit uniquement ses subscriptions
drop policy if exists "own push subscriptions read" on public.push_subscriptions;
create policy "own push subscriptions read"
  on public.push_subscriptions
  for select
  using (auth.uid() = user_id);

-- Insertion / mise à jour : un user ne peut écrire que ses propres rows
drop policy if exists "own push subscriptions write" on public.push_subscriptions;
create policy "own push subscriptions write"
  on public.push_subscriptions
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "own push subscriptions update" on public.push_subscriptions;
create policy "own push subscriptions update"
  on public.push_subscriptions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Suppression : un user peut effacer ses subscriptions ; l'edge function
-- (service_role) peut nettoyer les rows orphelines (HTTP 404/410 du provider).
drop policy if exists "own push subscriptions delete" on public.push_subscriptions;
create policy "own push subscriptions delete"
  on public.push_subscriptions
  for delete
  using (auth.uid() = user_id);
