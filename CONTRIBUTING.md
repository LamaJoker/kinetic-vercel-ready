# Contribuer à Kinetic

Merci de ton intérêt pour Kinetic ! Ce guide explique comment proposer une contribution.

## Sommaire

- [Setup local](#setup-local)
- [Workflow de contribution](#workflow-de-contribution)
- [Standards de code](#standards-de-code)
- [Tests](#tests)
- [Commit messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Reporting de bugs](#reporting-de-bugs)
- [Sécurité](#sécurité)

## Setup local

```bash
# Prérequis : Node 20+, pnpm 9+
git clone https://github.com/LamaJoker/kinetic-vercel-ready.git
cd kinetic-vercel-ready
pnpm install
cp .env.example .env  # remplis Supabase URL + ANON_KEY (ou laisse vide pour mode guest)
pnpm --filter @kinetic/core build
pnpm --filter @kinetic/adapters-web build
pnpm dev
```

Voir [README.md](README.md) et [DEPLOYMENT.md](DEPLOYMENT.md) pour plus de détails.

## Workflow de contribution

1. **Fork** + crée une branche depuis `main` : `git checkout -b feat/ma-feature`
2. **Code** + écris des **tests** (vitest pour la logique, Playwright pour l'E2E)
3. **Vérifie localement** : `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
4. **Commit** (un Husky pre-commit lance lint-staged automatiquement)
5. **Push** + ouvre une PR

Le pre-push hook lance `pnpm typecheck && pnpm test`. Tu peux le bypasser avec `--no-verify` mais ce n'est pas recommandé.

## Standards de code

- **TypeScript strict** : `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **ESLint** : `pnpm lint` doit passer avec **0 warning** (`--max-warnings 0`).
- **Prettier** : `pnpm format:check`. Auto-fix : `pnpm format`.
- **Pas de magic strings** `kinetic:*` : utilise `STORAGE_KEYS` depuis `@kinetic/core`.
- **Pas de `console.log`** en code de prod (seuls `console.error` / `console.warn` sont préservés).

### Architecture

- **packages/core** = domain pur (0 dépendance externe runtime). Toute logique métier vit ici.
- **packages/adapter-web** = adapters Supabase + IndexedDB + browser APIs.
- **apps/web** = UI Alpine.js + pages + stores.
- **Inversion de dépendances** via les ports (`packages/core/src/ports/`). Si tu ajoutes une dépendance externe au domain, **stop** — passe par un port.

### Accessibilité

- Tout élément interactif a un **nom accessible** (`aria-label`, texte visible, ou `aria-labelledby`).
- Les SVG décoratifs ont `aria-hidden="true" focusable="false"`.
- Les notifications utilisent `role="status"` ou `role="alert"` selon la sévérité.
- Tests automatisés : `pnpm e2e:a11y` (axe-core sur les pages clés).

### Performance

- Budget bundle : `pnpm size` (échoue si > seuils).
- Imports lourds → `import('...')` dynamique quand possible.
- Pas de polyfill global non nécessaire (cible ES2022).

## Tests

```bash
pnpm test              # vitest unit
pnpm test:watch        # vitest watch
pnpm coverage          # coverage avec seuils enforced (60% lines/funcs/stmts, 55% branches)
pnpm e2e               # Playwright sur build prod
pnpm e2e:a11y          # smoke a11y (axe-core)
```

- **Toute fonction de domain** doit avoir un test unitaire.
- **Tout nouveau parcours utilisateur critique** doit avoir un test E2E.
- Les tests d'a11y axe sont des smoke tests — `color-contrast` est désactivé (testé via Lighthouse).

## Commit messages

Format **Conventional Commits** :

```
<type>(<scope>): <sujet>

<corps optionnel>

<footer optionnel>
```

Types : `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `style`.

Exemples :

- `feat(nutrition): ajout du tracking de macros par repas`
- `fix(auth): magic link sur Safari iOS`
- `perf(bundle): chunk splitting des stores Alpine`

## Pull Requests

- Titre PR au format Conventional Commit.
- Description : **pourquoi** > **quoi** (le diff montre déjà le quoi).
- Coche tous les checks : lint, typecheck, unit, e2e, build, security.
- Si une PR touche la sécurité (RLS, headers, auth), tag `@security` dans la description pour review prioritaire.

## Reporting de bugs

Ouvre une **issue** avec :

- Étapes pour reproduire (numéros 1, 2, 3…)
- Comportement attendu vs observé
- Captures d'écran si pertinent
- Environnement (OS, navigateur, version PWA / APK)

## Sécurité

**Ne crée pas d'issue publique pour une vuln.** Envoie un email à l'équipe (voir SECURITY.md). Nous traitons en priorité.

---

Merci pour ta contribution ! 🚀
