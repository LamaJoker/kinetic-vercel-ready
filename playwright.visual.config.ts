import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  timeout: 180_000,
  workers: 1,
  reporter: [['github'], ['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'pnpm --filter @kinetic/web preview:ci',
    url: 'http://localhost:3000',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
