// playwright.config.ts

import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration Playwright pour Kinetic.
 * Cible : Chrome mobile (iPhone 14 Pro) + desktop.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Séquentiel pour respecter l'état IndexedDB

  // Retry 2x en CI pour les flaky tests réseau
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : 1,

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
    {
      name: 'mobile-chrome',
      use: {
        ...devices['iPhone 14 Pro'],
        channel: 'chrome',
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

  // Lancer le serveur de dev automatiquement
  webServer: {
    command: 'pnpm --filter @kinetic/web dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 30000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
