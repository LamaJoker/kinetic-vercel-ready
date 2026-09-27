/**
 * Captures d'écran de revue UX (mobile 390×844). Lancé uniquement par le
 * workflow `ux-screenshots` — pas par la CI E2E.
 */
import { test, type Page } from '@playwright/test';

const ROUTES: Array<[string, string]> = [
  ['/', 'dashboard'],
  ['/seances', 'seances'],
  ['/vitalite', 'vitalite'],
  ['/nutrition', 'nutrition'],
  ['/program', 'program'],
  ['/programs', 'programs'],
  ['/progression', 'progression'],
  ['/records', 'records'],
  ['/bodyweight', 'bodyweight'],
  ['/mensurations', 'mensurations'],
  ['/photos', 'photos'],
  ['/plates', 'plates'],
  ['/achievements', 'achievements'],
  ['/glossaire', 'glossaire'],
  ['/profile', 'profile'],
  ['/login', 'login'],
];

const DEMO = process.env['UX_DEMO'] === '1';

async function boot(page: Page, path: string, skipOnboarding = true): Promise<void> {
  if (skipOnboarding) {
    await page.addInitScript(() => {
      (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding = true;
    });
  }
  await page.goto(`http://localhost:3000${path}`);
  await page.waitForFunction(() => typeof (window as any).Alpine !== 'undefined', {
    timeout: 10_000,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:auth-ready')));
  await page.waitForFunction(
    () => (document.getElementById('app-outlet')?.childElementCount ?? 0) > 0,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(1200);
}

test.describe.configure({ mode: 'serial' });

test('onboarding', async ({ page }) => {
  await boot(page, '/onboarding', false);
  await page.screenshot({ path: 'ux-shots/00-onboarding.png', fullPage: true });
});

test('routes', async ({ page }) => {
  if (DEMO) {
    await boot(page, '/profile');
    await page.evaluate(async () => {
      const fn = (window as any).__kineticLoadDemo as (() => Promise<void>) | undefined;
      if (fn) await fn();
    });
  }
  let i = 1;
  for (const [path, name] of ROUTES) {
    await boot(page, path);
    await page.screenshot({
      path: `ux-shots/${String(i).padStart(2, '0')}-${name}.png`,
      fullPage: true,
    });
    i++;
  }
});
