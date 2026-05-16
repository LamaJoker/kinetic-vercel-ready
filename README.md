# ⚡ Kinetic — Performance OS

> Gamifie tes routines. Gagne des XP. Progresse chaque jour.

Application mobile PWA progressive pour la productivité et le fitness, construite avec Alpine.js, TypeScript et Supabase.

---

## 🏗️ Architecture

```
kinetic/
├── apps/
│   └── web/                    # Application principale (Alpine.js + Vite)
│       ├── public/             # Assets statiques + SW + manifest
│       └── src/
│           ├── lib/            # Utilitaires (analytics, performance, security, sync)
│           ├── pages/          # Fragments HTML Alpine.js
│           ├── stores/         # Stores Alpine (xp, auth, offline)
│           ├── deps.ts         # Injection de dépendances
│           └── main.ts         # Point d'entrée
├── packages/
│   ├── core/                   # Domaine métier pur (logique + ports)
│   └── adapter-web/            # Implémentations (IDB, Supabase, CRDT)
├── supabase/
│   └── migrations/             # SQL migrations versionnées
├── tests/
│   ├── unit/                   # Vitest — moteurs XP, streak, CRDT, sécurité
│   ├── integration/            # Vitest — HybridStorage
│   └── e2e/                    # Playwright — scénarios critiques
└── scripts/
    └── generate-icons.mjs      # Génération icônes PWA
```

### Stack technique

| Couche  | Choix                               | Raison                            |
| ------- | ----------------------------------- | --------------------------------- |
| UI      | Alpine.js 3                         | Léger, réactif, zéro build requis |
| Build   | Vite 5 + TypeScript 5.5             | ESM natif, HMR instantané         |
| Storage | IndexedDB (idb-keyval) + Supabase   | Offline-first + sync cloud        |
| Auth    | Supabase Auth (Google + Magic Link) | Clé en main, sécurisé             |
| Deploy  | Vercel (CDG1 — Paris)               | Edge network, CI intégrée         |
| Tests   | Vitest + Playwright                 | Rapides, fiables, E2E réel        |

---

## 🚀 Démarrage rapide

### Prérequis

- Node.js 20+
- pnpm 9+
- Compte Supabase (optionnel pour le dev)

### Installation

```bash
# 1. Cloner et installer
git clone https://github.com/ton-user/kinetic.git
cd kinetic
pnpm install

# 2. Configurer les variables d'environnement
cp .env.example apps/web/.env.local
# Éditer apps/web/.env.local avec tes clés Supabase

# 3. Lancer en développement
pnpm dev
# → http://localhost:3000
```

> **Mode sans backend** : sans variables Supabase, l'app fonctionne entièrement en mode "invité" avec stockage IDB local.

### Générer les icônes PWA

```bash
pnpm icons
# Produit apps/web/public/icons/*.png
```

---

## 🗄️ Base de données

### Configuration Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Copier `URL` et `anon key` dans `.env.local`
3. Appliquer les migrations :

```bash
# Via Supabase CLI
pnpm db:push

# Ou manuellement via SQL Editor :
# supabase/migrations/001_initial.sql
# supabase/migrations/002_optimizations.sql
```

### Activer Google OAuth

1. Supabase Dashboard → Authentication → Providers → Google
2. Créer un projet Google Cloud avec OAuth credentials
3. Ajouter `https://xxxx.supabase.co/auth/v1/callback` comme redirect URI

---

## 🧪 Tests

```bash
# Tests unitaires + intégration (avec coverage)
pnpm coverage

# Tests unitaires en watch mode
pnpm test:watch

# UI interactive Vitest
pnpm test:ui

# Tests E2E (lance le serveur automatiquement)
pnpm e2e

# E2E avec interface graphique
pnpm e2e:ui

# E2E en mode headed (voir le navigateur)
pnpm e2e:headed
```

### Coverage minimum requis (CI bloquant)

| Métrique   | Seuil | Réel  |
| ---------- | ----- | ----- |
| Lines      | 60%   | 60.2% |
| Functions  | 60%   | 67.5% |
| Branches   | 55%   | 86.5% |
| Statements | 60%   | 60.2% |

> **Note** : Pages Alpine et stores complexes exclus du périmètre de couverture unitaire (couverts par les tests Playwright E2E). La Phase 2 ciblera 80% avec happy-dom pour la couche stores.

---

## 📦 Build & Déploiement

### Build local

```bash
pnpm build
pnpm preview  # Tester le build en local → http://localhost:4173
```

### Déploiement Vercel

```bash
# Première fois
vercel login
vercel link

# Configurer les variables d'env dans Vercel Dashboard
# Settings → Environment Variables :
# VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

# Deploy production
vercel --prod
```

### Variables Vercel requises

Se référer à `.env.example` (unique source de vérité — copier vers `apps/web/.env.local`).

| Variable                    | Scope  | Description                                   |
| --------------------------- | ------ | --------------------------------------------- |
| `VITE_SUPABASE_URL`         | Client | URL projet Supabase                           |
| `VITE_SUPABASE_ANON_KEY`    | Client | Clé anonyme Supabase                          |
| `VITE_PUBLIC_SITE_URL`      | Client | URL canonique (requis pour APK Android OAuth) |
| `SUPABASE_URL`              | Server | URL Supabase pour use côté serveur            |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Service role (analytics + admin uniquement)   |

---

## ✅ CI/CD

Le pipeline GitHub Actions (`/.github/workflows/ci.yml`) exécute sur chaque push :

1. **Lint** — ESLint (dont interdiction des magic-strings `kinetic:`) + Prettier
2. **TypeScript** — `tsc --build` strict
3. **Audit dépendances** — `pnpm audit --prod` (informatif)
4. **Tests unitaires** — Vitest avec coverage (scope : `packages/*` + `apps/web/src/*`)
5. **Tests E2E** — Playwright sur Chrome mobile **et Safari/WebKit (iOS)**
6. **Build prod** — Vite build complet
7. **Lighthouse** _(PR uniquement)_ — Scores min : 85% perf, 90% a11y, 90% PWA

---

## 🔒 Sécurité

- **CSP** via `vercel.json` — `script-src 'unsafe-eval'` requis par Alpine.js (compilation de templates en runtime) ; migration vers AOT prévue en Phase 3
- **RLS** Supabase sur **toutes** les tables (y compris `vitals_metrics` depuis migration 006)
- **Quota** 1000 clés / 50MB par utilisateur
- **Rate limiting** client-side (magic link : 3 / 5min) + trigger SQL sur `vitals_metrics`
- **Sanitization** HTML-entity-encoding (whitelist) sur toutes les entrées utilisateur
- **HTTPS** forcé via HSTS (max-age: 2 ans)

---

## 📱 PWA

Kinetic est installable comme app native :

- **Android** : "Ajouter à l'écran d'accueil" dans Chrome
- **iOS** : Partager → "Sur l'écran d'accueil" dans Safari
- **Desktop** : Icône d'installation dans la barre d'adresse

Fonctionnalités offline :

- Lecture des données depuis IndexedDB
- Complétion de tâches sans connexion
- Synchronisation automatique au retour online

---

## 🗺️ Roadmap

- **Phase 1** ✅ — Onboarding, tâches, XP, streaks, PWA offline
- **Phase 2** 🔄 — Adaptation hebdomadaire, progressive overload, coach banner
- **Phase 3** 📋 — Push notifications, AI coach, analytics avancées, mode social

---

## 📄 Licence

MIT — © 2026 Kinetic
