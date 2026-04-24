// playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration Playwright pour Kinetic.
 * Cible : Chrome mobile (iPhone 14 Pro) + desktop.
 *
 * En CI : on sert le build de production via `vite preview --port 3000`
 *   (le job E2E fait `pnpm build` avant de lancer Playwright).
 *   Cela garantit que le Service Worker est enregistré (PROD=true).
 *
 * En local : serveur de dev Vite pour itération rapide.
 */
const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Séquentiel pour respecter l'état IndexedDB

  // Retry 2x en CI pour les flaky tests réseau
  retries: isCI ? 2 : 0,
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
    // Pas de channel: 'chrome' — CI installe Playwright Chromium, pas Chrome stable.
    {
      name: 'mobile-chrome',
      use: {
        ...devices['iPhone 14 Pro'],
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

  // En CI : servir le build de prod (SW enregistré, assets optimisés).
  // En local : serveur de dev Vite (rechargement rapide).
  webServer: {
    command: isCI
      ? 'pnpm --filter @kinetic/web preview:ci'
      : 'pnpm --filter @kinetic/web dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !isCI,
    timeout: 30000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
