/**
 * Captures d'écran de revue UX (mobile 390×844). Lancé uniquement par le
 * workflow `ux-screenshots` — pas par la CI E2E.
 */
import { test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

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
    // Parcours réel : onboarding → « Voir la démo »
    await boot(page, '/onboarding', false);
    await page.getByRole('button', { name: 'Voir la démo' }).click();
    await page.waitForURL('http://localhost:3000/', { timeout: 15_000 });
    await page.waitForTimeout(1500);
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

test('séance en cours', async ({ page }) => {
  test.skip(!DEMO, 'parcours capturé avec les données de démo');
  await boot(page, '/onboarding', false);
  await page.getByRole('button', { name: 'Voir la démo' }).click();
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Commencer la séance' }).click();
  await page.waitForURL('**/seances', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'ux-shots/20-seance-debut.png', fullPage: true });

  const addSet = page.getByRole('button', { name: '+ Série' }).first();
  const skipRest = page.getByRole('button', { name: 'Passer' });
  await addSet.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'ux-shots/21-seance-repos.png' });
  for (let i = 0; i < 2; i++) {
    if (await skipRest.isVisible()) await skipRest.click();
    await page.waitForTimeout(300);
    await addSet.click();
    await page.waitForTimeout(400);
  }
  if (await skipRest.isVisible()) await skipRest.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'ux-shots/22-seance-3-series.png', fullPage: true });

  await page.getByRole('button', { name: 'Sauver' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'ux-shots/23-seance-terminee.png', fullPage: true });
});

test('mode clair', async ({ page }) => {
  test.skip(!DEMO, 'capturé avec les données de démo');
  await page.addInitScript(() => localStorage.setItem('kinetic:theme-mode', 'light'));
  await boot(page, '/onboarding', false);
  await page.getByRole('button', { name: 'Voir la démo' }).click();
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  for (const [path, name] of [
    ['/', 'dashboard'],
    ['/nutrition', 'nutrition'],
    ['/progression', 'progression'],
    ['/profile', 'profile'],
  ] as const) {
    await boot(page, path);
    await page.screenshot({ path: `ux-shots/30-clair-${name}.png`, fullPage: true });
  }
});

test('rapport accessibilité (axe) de toutes les pages', async ({ page }) => {
  test.skip(!DEMO, 'avec les données de démo');
  test.setTimeout(240_000);
  await boot(page, '/onboarding', false);
  await page.getByRole('button', { name: 'Voir la démo' }).click();
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 });
  const report: Record<
    string,
    Array<{ id: string; impact: string | null; nodes: number; help: string }>
  > = {};
  for (const [path] of ROUTES) {
    await boot(page, path);
    const res = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .include('#app-outlet')
      .analyze();
    report[path] = res.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      nodes: v.nodes.length,
      help: v.help,
      samples: v.nodes.slice(0, 12).map((n) => ({
        target: n.target.join(' '),
        html: n.html.slice(0, 160),
        data: (n.any[0]?.data as Record<string, unknown> | undefined) ?? null,
      })),
    }));
  }
  mkdirSync('ux-shots', { recursive: true });
  writeFileSync('ux-shots/axe-report.json', JSON.stringify(report, null, 2));
});
