// playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration Playwright pour Kinetic.
 * Cible : Chrome mobile (iPhone 14 Pro) + desktop.
 *
 * En CI comme en local, on sert TOUJOURS le build de production via
 * `vite preview --port 3000`. Cela garantit :
 *   1. Parité exacte entre CI et local (plus de "passe en CI, échoue local")
 *   2. Service Worker enregistré → le test offline est valide
 *   3. Assets optimisés → timings réalistes
 *
 * Workflow local : `pnpm build && pnpm e2e`
 * CI : le job `e2e` fait `pnpm build` avant de lancer Playwright.
 */
const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Séquentiel pour respecter l'état IndexedDB

  // Retry 2x en CI pour les flaky tests réseau
  retries: isCI ? 2 : 1,
  workers: 1,

  reporter: [
    ['html', { outputFolder: 'tests/e2e/report', open: 'never' }],
    ['list'],
  ],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Viewport mobile par défaut (Kinetic est mobile-first)
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    // Permissions pour PWA
    permissions: ['notifications'],
  },

  projects: [
    // ── Mobile (primary target) ──────────────────────────────
    // devices['iPhone 14 Pro'] a defaultBrowserType: 'webkit' ;
    // on force chromium car CI n'installe que les binaires chromium.
    {
      name: 'mobile-chrome',
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'chromium',
      },
    },

    // ── Desktop (secondary) ──────────────────────────────────
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },

    // ── Firefox (cross-browser sanity) ───────────────────────
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  // Toujours servir le build de production (local et CI identiques).
  // En local : `pnpm build && pnpm e2e` (ou `pnpm e2e:full`).
  // Si le build est absent, vite preview affichera une erreur claire.
  webServer: {
    command: 'pnpm --filter @kinetic/web preview:ci',
    url: 'http://localhost:3000',
    // reuseExistingServer: permet de lancer pnpm e2e plusieurs fois sans rebuild
    reuseExistingServer: !isCI,
    timeout: 30000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
