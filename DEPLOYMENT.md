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
├── supabase/migrations/             # 001 → 003 (à appliquer dans l'ordre)
├── tests/{domain,usecases,unit,integration,e2e}/
├── vercel.json                      # Config déploiement
└── package.json                     # Scripts racine (monorepo)
```

Le cœur (`packages/core`) est 100 % pur, sans dépendance — 150+ tests unitaires. Les adapters web gèrent le monde réel (IndexedDB, Supabase). L'app n'est qu'une couche UI Alpine par-dessus.

## Variables d'environnement

Copier `env.example` → `.env.local` (local) et configurer dans Vercel (production) :

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

**Sans ces vars, Kinetic fonctionne en mode guest** (stockage IndexedDB local uniquement). C'est le fallback prévu — utile pour démos ou usage privé.

## Déploiement Vercel

### Réglages dashboard

| Paramètre | Valeur |
|-----------|--------|
| Root Directory | `/` |
| Framework Preset | **Other** |
| Build Command | *(vide — hérité de `vercel.json`)* |
| Output Directory | *(vide — hérité de `vercel.json`)* |
| Install Command | *(vide — hérité de `vercel.json`)* |
| Node.js Version | **20.x** |
| Environment Variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optionnels) |

### Ce que fait `vercel.json`

- `buildCommand: pnpm --filter @kinetic/web build` — monorepo-aware
- `outputDirectory: apps/web/dist`
- SPA rewrites : toutes les routes → `/index.html` sauf `/static/*` et les fichiers avec extension
- Cache immutable 1 an sur `/static/*`, `no-store` sur `/sw.js`
- Headers sécurité : CSP stricte, HSTS preload, frame-ancestors 'none', Permissions-Policy

### Commandes

```bash
pnpm install
pnpm build          # → apps/web/dist/
pnpm preview        # test local sur http://localhost:4173
pnpm vitest run     # 177 tests unitaires + intégration
pnpm test:e2e       # Playwright (nécessite browsers : pnpm playwright install)
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

Pour chaque provider, **Redirect URL** = `https://<votre-domaine-vercel>/auth/callback`.

En dev, ajouter aussi `http://localhost:3000/auth/callback` dans les URLs autorisées (Authentication → URL Configuration).

## Checklist pré-production

- [ ] Migration 003 appliquée
- [ ] Variables `VITE_SUPABASE_*` configurées dans Vercel
- [ ] Redirect URL OAuth enregistrée côté Supabase pour chaque provider et chaque domaine (prod + preview)
- [ ] `pnpm build` local passe sans warning
- [ ] `pnpm vitest run` → 177/177
- [ ] Lighthouse Mobile : LCP < 2.5 s, CLS < 0.1, TBT < 200 ms
- [ ] PWA installable (manifest.json + SW servis correctement — vérifier dans Chrome DevTools → Application)
- [ ] HTTPS + HSTS actifs (Vercel gère automatiquement)
- [ ] CSP sans erreur dans la console (vérifier en prod, pas en dev où Vite injecte du HMR)

## Bugs connus / limites actuelles

- **Pas de push notifications persistantes** : le SW a le handler `push` mais il manque l'inscription VAPID + endpoint backend pour les programmer. Phase 3 de la roadmap.
- **Pas de sync delta** : le RPC `get_changes_since` existe côté DB mais pas encore consommé côté client. Actuellement `HybridStorage.syncFromRemote()` tire TOUTES les clés.
- **Mode guest vs connecté** : changement de mode = rechargement de page requis (le singleton `getDeps()` se reset via `resetDeps()` au logout, mais la transition guest→connecté à chaud n'est pas gérée).
- **Tests e2e non exécutés en CI** : Playwright config présent mais pas de workflow GitHub Actions fourni.

## Roadmap

- **Phase 1 (current)** : PWA offline-first + gamification XP/streak + auth Supabase
- **Phase 2** : onboarding, génération de programmes, adaptation hebdomadaire
- **Phase 3** : push notifications (VAPID), sync delta, recommandations IA

## Dépannage

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
