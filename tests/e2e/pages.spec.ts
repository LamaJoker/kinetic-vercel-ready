/**
 * tests/e2e/pages.spec.ts — contrôle de TOUTES les pages.
 *
 * Pour chaque route déclarée dans router.ts (lue à l'exécution : une page
 * ajoutée est testée automatiquement), en état vide puis avec les données de
 * démo, on vérifie :
 *   1. aucune exception JS ni erreur d'expression Alpine (le build CSP échoue
 *      en silence sur Math, new Date, fonctions fléchées, x-html…) ;
 *   2. aucune ressource du site en erreur (404, 500) ;
 *   3. aucun « undefined », « NaN », « [object Object] » affiché ;
 *   4. pas de défilement horizontal (mise en page qui déborde sur mobile) ;
 *   5. un titre visible.
 * Puis quelques parcours fonctionnels clés.
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'http://localhost:3000';
const routerSource = readFileSync(resolve(__dirname, '../../apps/web/src/router.ts'), 'utf8');
const block = routerSource.match(/const ROUTES[^=]*=\s*\{([\s\S]*?)\n\};/)![1]!;
const ROUTES = [...block.matchAll(/^\s*'(\/[^']*)'\s*:/gm)].map((m) => m[1]!);
/** Pages sans contenu propre à contrôler (redirections / retour OAuth). */
const SKIP = new Set(['/auth-callback']);

interface Problems {
  errors: string[];
  badResponses: string[];
}

function watch(page: Page): Problems {
  const p: Problems = { errors: [], badResponses: [] };
  page.on('pageerror', (err) => p.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    const alpine =
      /Alpine (Expression )?(Error|Warning)|is not defined|prohibited in the CSP build/i;
    if ((msg.type() === 'error' || msg.type() === 'warning') && alpine.test(text)) {
      p.errors.push(`${msg.type()}: ${text.slice(0, 300)}`);
    } else if (
      msg.type() === 'error' &&
      !/supabase|VITE_|favicon|manifest|SW|Failed to load resource|net::ERR/i.test(text)
    ) {
      p.errors.push(`console.error: ${text.slice(0, 300)}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (url.startsWith(BASE) && res.status() >= 400) p.badResponses.push(`${res.status()} ${url}`);
  });
  return p;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).Alpine !== 'undefined', {
    timeout: 10_000,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:auth-ready')));
  await page.waitForFunction(
    () => (document.getElementById('app-outlet')?.childElementCount ?? 0) > 0,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(700);
}

async function goto(page: Page, path: string, skipOnboarding = true): Promise<void> {
  if (skipOnboarding) {
    await page.addInitScript(() => {
      (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding = true;
    });
  }
  await page.goto(`${BASE}${path}`);
  await waitForApp(page);
}

async function checkPage(page: Page, path: string, problems: Problems): Promise<void> {
  const report = await page.evaluate(() => {
    const outlet = document.getElementById('app-outlet');
    const visibleText = outlet ? outlet.innerText : '';
    const heading = [...document.querySelectorAll('#app-outlet h1, #app-outlet h2')].some(
      (h) => (h as HTMLElement).offsetParent !== null && h.textContent!.trim().length > 0,
    );
    return {
      leaks: (visibleText.match(/\b(undefined|NaN)\b|\[object Object\]/g) ?? []).slice(0, 5),
      overflowPx: document.documentElement.scrollWidth - window.innerWidth,
      heading,
    };
  });
  expect.soft(problems.errors, `${path} : erreurs JS/Alpine`).toEqual([]);
  expect.soft(problems.badResponses, `${path} : ressources en erreur`).toEqual([]);
  expect.soft(report.leaks, `${path} : valeurs brutes affichées`).toEqual([]);
  expect.soft(report.overflowPx, `${path} : débordement horizontal (px)`).toBeLessThanOrEqual(1);
  expect.soft(report.heading, `${path} : aucun titre visible`).toBe(true);
}

test.describe('Toutes les pages — état vide', () => {
  for (const path of ROUTES.filter((r) => !SKIP.has(r))) {
    test(`vide ${path}`, async ({ page }) => {
      const problems = watch(page);
      await goto(page, path, path !== '/onboarding');
      await checkPage(page, path, problems);
    });
  }
});

test.describe('Toutes les pages — avec données de démo', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('chaque page s affiche correctement', async ({ page }) => {
    await goto(page, '/onboarding', false);
    await page.getByRole('button', { name: 'Voir la démo' }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
    await waitForApp(page);

    for (const path of ROUTES.filter((r) => !SKIP.has(r) && r !== '/onboarding')) {
      await test.step(path, async () => {
        const problems = watch(page);
        await page.goto(`${BASE}${path}`);
        await waitForApp(page);
        await checkPage(page, path, problems);
        page.removeAllListeners('console');
        page.removeAllListeners('pageerror');
        page.removeAllListeners('response');
      });
    }
  });
});

test.describe('Parcours fonctionnels', () => {
  test('onboarding : créer son profil ouvre le tableau de bord', async ({ page }) => {
    const problems = watch(page);
    await goto(page, '/onboarding', false);
    await page.getByRole('button', { name: 'Créer mon profil' }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Commencer la séance' })).toBeVisible();
    expect(problems.errors).toEqual([]);
  });

  test('poids : enregistrer une pesée l ajoute à l historique', async ({ page }) => {
    await goto(page, '/bodyweight');
    await page.locator('input[x-model\\.number="newWeight"]').fill('81.4');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByText('81.4 kg').first()).toBeVisible();
  });

  test('chargement de barre : 140 kg dessine 3 disques par côté', async ({ page }) => {
    await goto(page, '/plates');
    await page.locator('input[x-model\\.number="targetKg"]').fill('140');
    await page.locator('input[x-model\\.number="targetKg"]').blur();
    const rects = page.locator('#app-outlet svg[role="img"] rect');
    await expect(rects).toHaveCount(4 + 3 * 2);
  });

  test('glossaire : la recherche filtre les termes', async ({ page }) => {
    await goto(page, '/glossaire');
    const before = await page.getByText('RPE', { exact: true }).count();
    await page.locator('input[x-model="query"]').fill('e1rm');
    await page.waitForTimeout(300);
    expect(before).toBeGreaterThan(0);
    await expect(page.getByText('e1RM', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('AMRAP', { exact: true })).toHaveCount(0);
  });

  test('séance : 3 séries puis sauvegarde apparaît dans l historique', async ({ page }) => {
    await goto(page, '/');
    await page.getByRole('button', { name: 'Commencer la séance' }).click();
    await page.waitForURL('**/seances', { timeout: 10_000 });
    await waitForApp(page);
    const addSet = page.getByRole('button', { name: '+ Série' }).first();
    await expect(addSet).toBeVisible();
    const skip = page.getByRole('button', { name: 'Passer' });
    for (let i = 0; i < 3; i++) {
      if (await skip.isVisible()) await skip.click();
      await addSet.click();
    }
    if (await skip.isVisible()) await skip.click();
    await page.getByRole('button', { name: 'Sauver' }).click();
    await expect(page.getByText('1 séance', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('nutrition : les barres de macros ont une largeur calculée', async ({ page }) => {
    await goto(page, '/onboarding', false);
    await page.getByRole('button', { name: 'Voir la démo' }).click();
    await page.waitForURL(`${BASE}/`, { timeout: 15_000 });
    await page.goto(`${BASE}/nutrition`);
    await waitForApp(page);
    const bars = page.locator('#app-outlet [role="progressbar"] > div');
    await expect(bars).toHaveCount(3);
    const widths = await bars.evaluateAll((els) => els.map((e) => (e as HTMLElement).style.width));
    expect(widths.every((w) => /^\d+%$/.test(w))).toBe(true);
    expect(widths.some((w) => w !== '0%')).toBe(true);
  });

  test('pages légales accessibles sans compte', async ({ page }) => {
    for (const path of ['/legal/cgu', '/legal/confidentialite']) {
      await page.goto(`${BASE}${path}`);
      await waitForApp(page);
      await expect(page.locator('#app-outlet h1')).toBeVisible();
    }
  });
});
