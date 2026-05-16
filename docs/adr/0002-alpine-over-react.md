# ADR 0002 — Alpine.js plutôt que React/Vue

- **Status** : Accepted
- **Date** : 2025-12-01

## Contexte

Kinetic vise une PWA mobile-first installable, packagée en APK Android via Capacitor. Le runtime doit être :

- **Léger** (cible < 50 KiB gzip pour le framework UI)
- **Compatible offline** (pas de SSR/hydration)
- **Simple à maintenir** par un seul développeur

## Décision

Adopter **Alpine.js 3** comme framework UI.

## Conséquences

### Positives

- Bundle Alpine = 46 KiB raw / 16 KiB gzip (vs React+ReactDOM ≈ 140 KiB gzip).
- Pas d'étape de build complexe : Alpine est progressif, lit le HTML directement.
- Pattern `x-data` + `$store` suffisant pour la complexité actuelle (12 pages, ~8 stores).
- Capacitor + Alpine fonctionnent sans pont JS bridge custom.

### Négatives

- **Pas de type safety** sur les bindings `x-data` (HTML lu en string).
- **DevTools limités** par rapport à React (pas de time-travel debugger).
- **Communauté plus petite** : moins de plugins, moins de Q&A Stack Overflow.
- Difficile de tester les composants UI en isolation → on s'appuie sur Playwright.

### Mitigations

- Pages testées via **Playwright E2E** (couverture comportementale).
- Logique extraite dans `packages/core` (testée 100 % en pure TS).
- Stores Alpine déclarés dans des fichiers TypeScript (`apps/web/src/stores/*.ts`) pour bénéficier de la vérification de type au point de définition.

## Alternatives considérées

1. **React + Vite SSG** : trop lourd (140 KiB gzip), overkill pour 12 pages.
2. **Svelte + SvelteKit** : excellent mais courbe d'apprentissage Capacitor moins documentée.
3. **Vue 3 + Pinia** : trop lourd (60 KiB gzip Vue + 12 KiB Pinia), runtime templating proche d'Alpine.
4. **Vanilla JS** : maintenir la réactivité à la main = bug factory.
