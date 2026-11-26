/**
 * tests/e2e/navigation-lifecycle.spec.ts
 *
 * QA-10 : en quittant une page, le destroy() de ses composants s'exécute UNE fois
 * (avant : appel manuel du routeur, puis second appel par Alpine au retrait des nœuds).
 */
import { test, expect } from '@playwright/test';

interface ProbeWindow {
  Alpine?: {
    data(name: string, factory: () => object): void;
    initTree(el: HTMLElement): void;
  };
  __probeDestroyed?: number;
}

test('destroy() d’un composant de page appelé une seule fois par navigation', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding = true;
  });
  await page.goto('http://localhost:3000/manifest.json');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignoré */
    }
  });
  await page.goto('http://localhost:3000/');
  await page.waitForFunction(() => (window as ProbeWindow).Alpine !== undefined);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:auth-ready')));
  await expect(page.locator('a[href="/vitalite"]').first()).toBeVisible({ timeout: 10_000 });

  // Composant sonde dans la page affichée (même cycle de vie qu'un composant de page).
  await page.evaluate(() => {
    const w = window as ProbeWindow;
    w.__probeDestroyed = 0;
    w.Alpine!.data('kineticProbe', () => ({
      destroy() {
        w.__probeDestroyed = (w.__probeDestroyed ?? 0) + 1;
      },
    }));
    const probe = document.createElement('div');
    probe.setAttribute('x-data', 'kineticProbe');
    document.getElementById('app-outlet')!.appendChild(probe);
    w.Alpine!.initTree(probe);
  });

  await page.locator('a[href="/vitalite"]').first().click();
  await expect(page).toHaveURL(/vitalite/);
  // L'observateur de mutations d'Alpine passe après le remplacement de la page.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as ProbeWindow).__probeDestroyed)).toBe(1);
});
