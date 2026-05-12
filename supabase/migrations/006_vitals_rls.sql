-- supabase/migrations/006_vitals_rls.sql
-- ══════════════════════════════════════════════════════════════
-- Durcissement : activer RLS sur vitals_metrics.
--
-- Contexte : la table collectait les Web Vitals anonymement via INSERT
-- public (anon key). Sans RLS, n'importe quelle IP pouvait remplir la
-- table librement (seul garde-fou = trigger rate-limit par IP hash).
--
-- Nouvelle approche : activer RLS + une politique permissive d'INSERT
-- limitée à l'anon role, tout en bloquant SELECT/UPDATE/DELETE via RLS.
-- Le trigger rate-limit de la migration 003 reste en place comme
-- deuxième couche.
--
-- Note : la valeur `anon` correspond au rôle Supabase anonyme.
-- ══════════════════════════════════════════════════════════════

alter table public.vitals_metrics enable row level security;

-- INSERT autorisé pour le rôle anon (collecte Web Vitals sans auth)
create policy "vitals_insert_anon"
  on public.vitals_metrics
  for insert
  to anon
  with check (
    -- Valider que les champs respectent les contraintes métier côté RLS
    name    in ('LCP', 'CLS', 'FID', 'INP', 'TTFB', 'FCP')
    and rating in ('good', 'needs-improvement', 'poor')
    and value >= 0
  );

-- SELECT autorisé uniquement pour le rôle service_role (analytics backend)
-- Les utilisateurs authentifiés ne voient pas les vitals des autres.
create policy "vitals_select_service"
  on public.vitals_metrics
  for select
  to service_role
  using (true);

-- Pas de UPDATE/DELETE via RLS : les données vitals sont immuables une
-- fois insérées. Le nettoyage se fait via pg_cron sur le rôle service_role.

-- Forcer RLS même pour les rôles bypassant RLS par défaut
alter table public.vitals_metrics force row level security;
