# Kinetic — Guide de déploiement

PWA gamifiée de productivité personnelle. Stack : Alpine.js + Vite + pnpm monorepo, déployée sur Vercel, base de données et auth sur Supabase (optionnel).

## Architecture

```
kinetic/
├── apps/web/                        # Frontend Vite (build target Vercel)
│   ├── index.html
│   ├── src/
│   │   ├── main.ts                  # Entrée — orchestre stores + router
│   │   ├── router.ts                # SPA History API, pages bundlées
│   │   ├── deps.ts                  # Container DI (ports → impls)
│   │   ├── stores/                  # Alpine stores (auth, xp, vitalite, …)
│   │   ├── pages/                   # Templates HTML + composants Alpine
│   │   ├── lib/                     # perf, security, analytics, sync
│   │   └── styles.css               # Tailwind entrée
│   └── public/sw.js                 # Service Worker PWA
├── packages/
│   ├── core/                        # Domaine pur + ports + use-cases (0 dep externe)
│   └── adapter-web/                 # Impls : IdbStorage, Supabase, …
├── supabase/migrations/             # 001 → 009 (à appliquer dans l'ordre)
├── supabase/functions/              # Edge Functions (ai-coach, send-push, report-error)
├── tests/{domain,usecases,unit,integration,e2e}/
├── vercel.json                      # Config déploiement
└── package.json                     # Scripts racine (monorepo)
```

Le cœur (`packages/core`) est 100 % pur, sans dépendance, et couvert par la suite Vitest. Les adapters web gèrent le monde réel (IndexedDB, Supabase). L'app n'est qu'une couche UI Alpine par-dessus.

## Variables d'environnement

Copier `env.example` → `.env.local` (local) et configurer dans Vercel (production) :

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

**Sans ces vars, Kinetic fonctionne en mode guest** (stockage IndexedDB local uniquement). C'est le fallback prévu — utile pour démos ou usage privé.

## Déploiement Vercel

### Réglages dashboard

| Paramètre             | Valeur                                                     |
| --------------------- | ---------------------------------------------------------- |
| Root Directory        | `/`                                                        |
| Framework Preset      | **Other**                                                  |
| Build Command         | _(vide — hérité de `vercel.json`)_                         |
| Output Directory      | _(vide — hérité de `vercel.json`)_                         |
| Install Command       | _(vide — hérité de `vercel.json`)_                         |
| Node.js Version       | **20.x**                                                   |
| Environment Variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optionnels) |

### Ce que fait `vercel.json`

- `buildCommand: pnpm --filter @kinetic/web build` — monorepo-aware
- `outputDirectory: apps/web/dist`
- Entrées SPA : `scripts/spa-entrypoints.mjs` génère un `<route>.html` par route lue dans `router.ts` (servis via `cleanUrls`), plus une rewrite de secours vers `/index.html`
- Cache immutable 1 an sur `/static/*`, `no-store` sur `/sw.js`
- Headers sécurité : CSP stricte, HSTS preload, frame-ancestors 'none', Permissions-Policy

### Commandes

```bash
pnpm install
pnpm build          # → apps/web/dist/
pnpm preview        # test local sur http://localhost:4173
pnpm test           # tests unitaires + intégration (Vitest)
pnpm e2e:full       # build E2E + Playwright (nécessite : pnpm exec playwright install)
```

## Déploiement Supabase

### 1. Projet

Créer un projet sur [supabase.com](https://supabase.com). Récupérer URL + anon key.

### 2. Migrations (ordre strict)

Via CLI :

```bash
supabase link --project-ref <ref>
supabase db push
```

Ou via le **SQL Editor** du dashboard — coller dans l'ordre :

1. `supabase/migrations/001_initial.sql` — schéma initial
2. `supabase/migrations/002_optimizations.sql` — index, RLS stricte, quota 50 MB
3. `supabase/migrations/003_security_hardening.sql` — **obligatoire pour la prod**
4. `004_training_tables.sql` → `008_ai_coach_usage.sql` — tables d'entraînement, push, quota IA
5. `supabase/migrations/009_sync_entitlements_hardening.sql` — **obligatoire** : RPC `sync_pull` (delta sync sur horloge serveur), quota corrigé, table `entitlements`, quota IA atomique, `keep_alive`

La migration 003 ferme 5 vulnérabilités :

- `SET search_path` sur toutes les `SECURITY DEFINER` (injection de schéma)
- Validation d'entrée dans `upsert_daily_log` (bornes XP/tasks/streak)
- Vues en `SECURITY INVOKER` explicite
- Rate limit 60/min/IP sur `vitals_metrics`
- `FORCE ROW LEVEL SECURITY` + permissions strictes (`daily_logs` append-only)

### 3. Auth

Dashboard Supabase → Authentication → Providers :

- **Email** (Magic Link) : activer, configurer le template email
- **Google OAuth** : créer OAuth client Google Cloud, ajouter Client ID + Secret
- **GitHub OAuth** : créer OAuth app GitHub, ajouter Client ID + Secret

Pour chaque provider, **Redirect URL** = `https://<votre-domaine-vercel>/auth-callback` (l'ancien `/auth/callback` reste servi pour compatibilité).

En dev, ajouter aussi `http://localhost:3000/auth-callback` dans les URLs autorisées (Authentication → URL Configuration).

### 4. Edge Functions

```bash
supabase functions deploy ai-coach
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set ANTHROPIC_MODEL=claude-sonnet-5   # optionnel
supabase secrets set ALLOWED_ORIGINS=https://<votre-domaine-vercel>,capacitor://localhost,https://localhost
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés automatiquement par Supabase.

## Checklist pré-production

- [ ] Migrations 001 → 009 appliquées
- [ ] Variables `VITE_SUPABASE_*` configurées dans Vercel
- [ ] Redirect URL OAuth enregistrée côté Supabase pour chaque provider et chaque domaine (prod + preview)
- [ ] `pnpm build` local passe sans warning
- [ ] `pnpm test` vert
- [ ] Lighthouse Mobile : LCP < 2.5 s, CLS < 0.1, TBT < 200 ms
- [ ] PWA installable (manifest.json + SW servis correctement — vérifier dans Chrome DevTools → Application)
- [ ] HTTPS + HSTS actifs (Vercel gère automatiquement)
- [ ] CSP sans erreur dans la console (vérifier en prod, pas en dev où Vite injecte du HMR)

## Bugs connus / limites actuelles

- **Pas de push notifications persistantes** : le SW a le handler `push` mais il manque l'inscription VAPID + endpoint backend pour les programmer. Phase 3 de la roadmap.
- **Résolution de conflit Last-Write-Wins par clé** : deux appareils qui modifient _la même_ clé hors-ligne → la dernière écriture gagne. Les séances ont une clé chacune, donc l'ajout de séances en parallèle ne perd rien (voir ADR 0004).
- **Mode guest vs connecté** : changement de mode = rechargement de page requis (le singleton `getDeps()` se reset via `resetDeps()` au logout, mais la transition guest→connecté à chaud n'est pas gérée).
- **E2E en mode invité uniquement** : l'auth et la synchro Supabase ne sont pas encore couvertes de bout en bout (prochaine étape : `supabase start` en CI).

## Roadmap

- **Phase 1 (current)** : PWA offline-first + gamification XP/streak + auth Supabase
- **Phase 2** : onboarding, génération de programmes, adaptation hebdomadaire
- **Phase 3** : push notifications (VAPID), sync delta, recommandations IA

## Dépannage

### Projet Supabase en pause (plan Free inactif)

Symptômes : connexion impossible, requêtes en **HTTP 540**, l'app retombe en mode invité (les données locales restent intactes).

1. Dashboard Supabase → sélectionner le projet → **Restore project**. Les données et la configuration reviennent en quelques minutes.
2. Si la restauration en un clic n'est plus proposée (pause trop ancienne) : télécharger la sauvegarde depuis _Project Overview_, créer un nouveau projet, restaurer la base, réappliquer les migrations manquantes (`supabase db push`), redéployer les Edge Functions, puis mettre à jour `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` dans Vercel **et** dans les secrets GitHub, et redéployer.
3. Reconfigurer _Authentication → URL Configuration_ (Site URL + Redirect URLs) sur le nouveau projet.
4. Pour éviter la prochaine pause : le workflow `.github/workflows/supabase-keep-alive.yml` appelle la RPC `keep_alive` tous les 3 jours (déclenchable à la main via _Actions → Supabase keep-alive → Run workflow_). Un plan payant n'est jamais mis en pause.

### `No Output Directory named "dist" found`

Root Directory mal configuré sur Vercel. Doit être `/`, pas `apps/web`. Voir section Réglages dashboard.

### `Command "build" not found`

`package.json` racine sans script `build`. Restaurer :

```json
"scripts": { "build": "pnpm --filter @kinetic/web build" }
```

### `ERR_PNPM_OUTDATED_LOCKFILE` en local

Après modif des `package.json` :

```bash
rm pnpm-lock.yaml && pnpm install
```

(En CI on garde `--frozen-lockfile` : le lockfile à jour doit être commité.)

### Magic link Supabase ne fonctionne pas

Vérifier dans Supabase → Auth → URL Configuration que le domaine de déploiement est dans **Redirect URLs**. Le domaine preview Vercel change à chaque PR → ajouter `https://*.vercel.app` en wildcard si besoin.

### Service Worker cache une vieille version

DevTools → Application → Service Workers → **Unregister**, puis hard refresh. En prod, chaque build bump le `VERSION` en haut de `sw.js` et l'ancien cache est purgé au `activate`.
