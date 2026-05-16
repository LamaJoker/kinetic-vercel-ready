/**
 * tests/e2e/a11y.spec.ts
 *
 * Tests d'accessibilité automatisés avec axe-core.
 * Vérifient les règles WCAG 2.1 AA sur les pages clés.
 *
 * Note : axe-core ne détecte qu'environ 30 % des problèmes d'a11y.
 * Les tests manuels (lecteur d'écran, navigation clavier) restent essentiels.
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function setupApp(page: Page, path = '/'): Promise<void> {
  await page.goto('http://localhost:3000/manifest.json');

  // Avoid IDB writes from test context — causes WebKit IDB connection
  // hang on subsequent app navigation. See kinetic.spec.ts gotoApp() comment.
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignored */
    }
  });

  await page.goto(`http://localhost:3000${path}`);
  await page.waitForFunction(
    () => {
      const a = (window as any).Alpine;
      if (!a?.store) return false;
      const auth = a.store('auth') as { loading?: boolean } | null;
      return auth != null && auth.loading === false;
    },
    { timeout: 10_000 },
  );
  // Dispatch onboarding-complete only — it bypasses the IDB onboarding check
  // (hangs on mobile-safari CI) AND triggers a render(). Dispatching auth-ready
  // in addition would cause a second render whose rIC re-focuses host AFTER
  // the test's skipLink.focus() → breaks the Skip-link a11y test.
  // See kinetic.spec.ts gotoApp() for the full rationale.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('kinetic:onboarding-complete'));
  });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('app-outlet');
      return el != null && el.hasChildNodes();
    },
    { timeout: 10_000 },
  );
}

/**
 * Lance axe sur la page et fail si des violations bloquantes existent.
 * On n'exige PAS zéro violation (Tailwind/Alpine en ont quelques-unes inévitables)
 * mais on bloque sur les WCAG 2A et 2AA critical/serious.
 */
async function runAxe(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules([
      // Tailwind utility classes peuvent générer des color-contrast borderlines
      // qu'on traite via Lighthouse plutôt qu'ici.
      'color-contrast',
    ])
    .analyze();

  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );

  if (critical.length > 0) {
    console.log(`[a11y:${name}] ${critical.length} violation(s) critical/serious :`);
    for (const v of critical) {
      console.log(`  - ${v.id} (${v.impact}): ${v.description}`);
      for (const node of v.nodes.slice(0, 3)) {
        console.log(`    → ${node.target.join(', ')}`);
      }
    }
  }

  expect(critical).toEqual([]);
}

test.describe('A11y — Smoke (axe-core)', () => {
  test('Dashboard /', async ({ page }) => {
    await setupApp(page, '/');
    await runAxe(page, 'dashboard');
  });

  test('Vitalité /vitalite', async ({ page }) => {
    await setupApp(page, '/vitalite');
    await runAxe(page, 'vitalite');
  });

  test('Profil /profile', async ({ page }) => {
    await setupApp(page, '/profile');
    await runAxe(page, 'profile');
  });

  test('Séances /seances', async ({ page }) => {
    await setupApp(page, '/seances');
    await runAxe(page, 'seances');
  });

  test('Poids corporel /bodyweight', async ({ page }) => {
    await setupApp(page, '/bodyweight');
    await runAxe(page, 'bodyweight');
  });

  test('Mensurations /mensurations', async ({ page }) => {
    await setupApp(page, '/mensurations');
    await runAxe(page, 'mensurations');
  });

  test('Nutrition /nutrition', async ({ page }) => {
    await setupApp(page, '/nutrition');
    await runAxe(page, 'nutrition');
  });

  test('Programme /program', async ({ page }) => {
    await setupApp(page, '/program');
    await runAxe(page, 'program');
  });

  test('Progression /progression', async ({ page }) => {
    await setupApp(page, '/progression');
    await runAxe(page, 'progression');
  });

  test('Skip-link visible au focus', async ({ page }) => {
    await setupApp(page, '/');
    // Le router appelle host.focus() via requestIdleCallback après le rendu.
    // La position dans l'ordre de tabulation varie selon le navigateur : Firefox
    // reprend parfois depuis l'élément précédemment focalisé (#app-outlet) au lieu
    // du début du document. On test directement la capacité du skip-link à être
    // focalisé et à devenir visible, sans dépendre de l'ordre de tabulation.
    const skipLink = page.locator('a[href="#app-outlet"]');
    await skipLink.focus();
    // Après focus, sr-only → focus:not-sr-only le rend visible
    await expect(skipLink).toBeVisible();
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    expect(focused).toContain('contenu principal');
  });

  test('Nav principale a un aria-label', async ({ page }) => {
    await setupApp(page, '/');
    const nav = page.locator('nav[aria-label]').first();
    await expect(nav).toBeVisible();
    const label = await nav.getAttribute('aria-label');
    expect(label).toBeTruthy();
  });

  test('Lien actif a aria-current="page"', async ({ page }) => {
    await setupApp(page, '/vitalite');
    const activeLink = page.locator('a[aria-current="page"]');
    await expect(activeLink.first()).toBeVisible();
  });
});
