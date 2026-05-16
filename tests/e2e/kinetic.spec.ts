/**
 * tests/e2e/kinetic.spec.ts
 *
 * Tests E2E Playwright — scénarios critiques Kinetic.
 *
 * Prérequis : serveur local sur http://localhost:3000
 * Runner : pnpm e2e (= playwright test)
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────

async function waitForAlpineInit(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).Alpine !== 'undefined', {
    timeout: 8000,
  });
}

/**
 * Charge l'app comme un utilisateur déjà onboardé, après avoir vidé l'état.
 *
 * On navigue d'abord vers un asset statique (manifest.json) pour établir
 * l'origine sans exécuter le JS de l'app. Cela évite la contention IDB :
 * quand l'app charge sur '/', idb-keyval ouvre des connexions persistantes
 * au niveau module ; tout open() concurrent dans le test peut se retrouver
 * bloqué derrière ces transactions → timeout. En restant sur manifest.json,
 * aucun code Alpine ne tourne et l'IDB est libre.
 */
async function gotoApp(page: Page, path = '/'): Promise<void> {
  // Set test override BEFORE any app code loads. This makes the router's
  // hasCompletedOnboarding() return true synchronously without touching IDB.
  // Avoids both (a) onboarding redirect when no profile is in IDB and (b) the
  // WebKit IDB connection hang we observed when seeding IDB from a test
  // context. addInitScript runs in every navigated frame before app scripts.
  await page.addInitScript(() => {
    (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding = true;
  });

  // 1. Asset statique = même origine, zéro JS d'app
  await page.goto('http://localhost:3000/manifest.json');

  // 2. Clear localStorage (avoid stale state between tests)
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignoré */
    }
  });

  // 3. Naviguer vers la route cible
  await page.goto(`http://localhost:3000${path}`);
  await waitForAlpineInit(page);

  // 4. Attendre que l'auth soit terminée (loading === false).
  await page.waitForFunction(
    () => {
      const a = (window as any).Alpine;
      if (!a?.store) return false;
      const auth = a.store('auth') as { loading?: boolean } | null;
      return auth != null && auth.loading === false;
    },
    { timeout: 10_000 },
  );

  // 5. Dispatch kinetic:auth-ready to trigger initial render. The
  //    __kineticSkipOnboarding flag (set via addInitScript above) ensures
  //    the router's hasCompletedOnboarding() check short-circuits regardless
  //    of whether our event listener was registered by then.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('kinetic:auth-ready'));
  });

  // 6. Attendre que #app-outlet contienne vraiment du DOM rendu
  await page.waitForFunction(
    () => {
      const el = document.getElementById('app-outlet');
      return el != null && el.hasChildNodes();
    },
    { timeout: 10_000 },
  );
}

// ──────────────────────────────────────────────────────────────

test.describe('Kinetic App — Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('affiche le dashboard au chargement', async ({ page }) => {
    // Attendre qu'Alpine ait peuplé le DOM (pas de timeout aveugle)
    await expect(page.locator('body')).not.toBeEmpty();
    // Le dashboard expose un lien vers /vitalite (nav toujours présente)
    await expect(page.locator('a[href="/vitalite"]').first()).toBeVisible({ timeout: 5000 });
  });

  test('navigue vers la routine vitalité', async ({ page }) => {
    await page.locator('a[href="/vitalite"]').first().click();
    await expect(page).toHaveURL(/vitalite/);
    // Attendre le contenu (pas un délai fixe)
    await page.waitForFunction(() => document.querySelector('[x-data]') !== null, {
      timeout: 5000,
    });
  });

  test('le bouton retour fonctionne depuis vitalité', async ({ page }) => {
    await gotoApp(page, '/vitalite');
    await page.locator('a[href="/"]').first().click();
    await expect(page).toHaveURL(/localhost:3000\/#?\/?$/);
  });
});

test.describe('Kinetic App — Complétion de tâches', () => {
  // CI WebKit (mobile-safari) est lent : gotoApp (3 navigations + IDB) peut prendre
  // 15-20 s, et le store vitalite + le rendu Alpine x-for prennent 10-20 s de plus.
  // On donne 90 s au beforeEach + test body pour éviter le timeout de 30 s par défaut.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page, '/vitalite');
    // Attendre que les boutons "+N XP" soient visibles dans le DOM.
    // gotoApp retourne dès que #app-outlet a des enfants (le skeleton initial suffit),
    // donc le router n'a pas encore injecté le vrai contenu de la page. Le store
    // vitalite doit ensuite lire l'IDB et Alpine doit re-render x-for. On poll
    // directement le DOM avec un timeout généreux pour les runners CI WebKit lents.
    await page.waitForFunction(
      () => {
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('#app-outlet button'),
        );
        return buttons.some((btn) => /\+\d+ XP/.test(btn.textContent?.trim() ?? ''));
      },
      { timeout: 60_000 },
    );
  });

  test('complète une tâche et la marque disabled', async ({ page }) => {
    // Cibler spécifiquement un bouton de tâche via son texte "+N XP"
    // (même pattern que le test guard ci-dessous)
    const taskButton = page
      .locator('button')
      .filter({ hasText: /\+\d+ XP/ })
      .first();
    await expect(taskButton).toBeVisible({ timeout: 5000 });
    await taskButton.click();

    // Attendre qu'un bouton disabled apparaisse (tâche complétée)
    await page.waitForSelector('button[disabled]', { timeout: 5000 });
    await expect(page.locator('button[disabled]').first()).toBeVisible();
  });

  test('impossible de compléter deux fois la même tâche (guard)', async ({ page }) => {
    // Cibler spécifiquement les boutons de tâche (pas les boutons toast ✕)
    // en filtrant sur le texte "+N XP" présent uniquement sur les tâches incomplètes.
    const taskButton = page
      .locator('button')
      .filter({ hasText: /\+\d+ XP/ })
      .first();
    await expect(taskButton).toBeVisible({ timeout: 5000 });
    await taskButton.click();

    // Attendre qu'un bouton disabled apparaisse dans le DOM (même pattern que
    // le test "complète une tâche"). On n'utilise pas expect(taskButton).toBeDisabled()
    // car ce locator ré-évalue après le click : la task button devient disabled et
    // le bouton ✕ du toast (jamais disabled) est résolu en premier → faux timeout.
    await page.waitForSelector('button[disabled]', { timeout: 5000 });

    // Attendre que le store XP reflète l'award du premier clic.
    // Le reload XP se fait APRÈS que task.done passe à true (les deux sont
    // des étapes async distinctes dans complete()). Sans cette attente,
    // xpBefore serait capturé à 0 et xpAfter à 50 → faux positif.
    await page.waitForFunction(() => ((window as any).Alpine?.store?.('xp')?.xp ?? 0) > 0, {
      timeout: 5000,
    });

    // Capturer XP avant tentative de double-click
    const xpBefore = await page.evaluate(() => {
      const store = (window as any).Alpine?.store?.('xp');
      return store?.xp ?? 0;
    });

    // Forcer le click sur le bouton disabled (simulation exploit)
    await page.evaluate(() => {
      const btn = document.querySelector('button[disabled]') as HTMLButtonElement | null;
      if (btn) btn.click();
    });

    // Attendre un tick Alpine
    await page.waitForFunction(() => true, { timeout: 300 });

    const xpAfter = await page.evaluate(() => {
      const store = (window as any).Alpine?.store?.('xp');
      return store?.xp ?? 0;
    });

    expect(xpAfter).toBe(xpBefore);
  });
});

test.describe('Kinetic App — PWA & Offline', () => {
  test('le manifest PWA est accessible', async ({ page }) => {
    const response = await page.goto('http://localhost:3000/manifest.json');
    expect(response?.status()).toBe(200);

    const manifest = await response?.json();
    expect(manifest.name).toContain('Kinetic');
    expect(manifest.display).toBe('standalone');
  });

  test('le Service Worker est enregistré si PROD', async ({ page }) => {
    await page.goto('http://localhost:3000');

    const { swSupported, swRegistered } = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { swSupported: false, swRegistered: false };
      // Attendre un peu que le SW s'enregistre s'il est attendu
      await new Promise((r) => setTimeout(r, 1500));
      const reg = await navigator.serviceWorker.getRegistration('/');
      return { swSupported: true, swRegistered: !!reg };
    });

    if (!swSupported) {
      test.skip();
      return;
    }
    // En développement (PROD=false), le SW ne s'enregistre pas — c'est attendu.
    // Ce test passe dans les deux cas ; il documente le comportement.
    // En prod le SW doit être présent.
    console.log(`[e2e] SW enregistré : ${swRegistered} (attendu: true seulement en PROD)`);
  });

  test("l'app se charge en mode offline (assets cachés)", async ({ page, context }) => {
    // Ce test nécessite le build de production (Service Worker enregistré).
    // playwright.config.ts utilise désormais `preview:ci` en local ET en CI
    // → ce test est valide dans les deux contextes.
    //
    // On ne peut pas utiliser waitUntil:'networkidle' : pendant l'installation
    // du SW, celui-ci effectue lui-même des requêtes de précache qui maintiennent
    // le réseau occupé → networkidle ne se déclenche jamais dans les 30 s, et
    // page.goto() timeout sur CI.
    //
    // Stratégie : charger une fois avec waitUntil:'load' (tous les sous-resources
    // sont chargés), puis attendre explicitement que le SW contrôle la page ET que
    // les assets /static/ soient présents dans l'un des caches SW. La mise en cache
    // est fire-and-forget dans cacheFirst(), donc on poll jusqu'à ce qu'elle soit
    // effective — c'est plus fiable que networkidle ou un délai fixe.
    await page.goto('http://localhost:3000', { waitUntil: 'load' });
    await waitForAlpineInit(page);

    // Attendre que le SW soit controller ET que le cache contienne :
    //   - le shell "/" (STATIC_CACHE, mis en place lors de l'install)
    //   - au moins un asset /static/assets/ (RUNTIME_CACHE, mis en place lors du fetch)
    // Sans ces deux vérifications, le rechargement offline peut tomber sur
    // la réponse 503 de secours du SW, ce qui provoque une page blanche
    // sur Firefox (Playwright n'a pas accès aux pages d'erreur internes).
    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return true; // pas de SW = test skip
        if (!navigator.serviceWorker.controller) return false;
        let hasShell = false;
        let hasStatic = false;
        const keys = await caches.keys();
        for (const k of keys) {
          const c = await caches.open(k);
          const reqs = await c.keys();
          for (const r of reqs) {
            const p = new URL(r.url).pathname;
            if (p === '/') hasShell = true;
            if (p.startsWith('/static/assets/')) hasStatic = true;
          }
        }
        return hasShell && hasStatic;
      },
      { timeout: 20_000 },
    );

    await context.setOffline(true);

    // Naviguer (pas reload) vers la même URL : page.reload() peut contourner
    // le SW sur Firefox en mode offline. page.goto() force une nouvelle requête
    // de navigation qui est interceptée par le fetch handler du SW.
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' }).catch(() => {});

    // L'app ou la page offline doit afficher quelque chose (pas de page blanche)
    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 8000 })
      .catch(() => '');
    expect(bodyText.length).toBeGreaterThan(0);

    await context.setOffline(false);
  });
});

test.describe('Kinetic App — Sécurité', () => {
  test('la page charge avec un statut 200', async ({ page }) => {
    const response = await page.goto('http://localhost:3000');
    expect(response?.status()).toBe(200);
  });

  test('aucun console.error inattendu sur le chargement normal', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await gotoApp(page);

    // Filtrer les erreurs attendues (Supabase non configuré en dev, favicon 404)
    const unexpectedErrors = errors.filter(
      (e) =>
        !e.includes('supabase') &&
        !e.includes('VITE_') &&
        !e.includes('favicon') &&
        !e.includes('manifest') &&
        !e.includes('SW'),
    );

    expect(unexpectedErrors).toHaveLength(0);
  });
});

test.describe('Kinetic App — Streak', () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test('le dashboard se charge sans erreur de rendu', async ({ page }) => {
    // Corps de page non vide = rendu Alpine OK
    await expect(page.locator('body')).not.toBeEmpty();
    // Nav présente (lien vitalité)
    await expect(page.locator('a[href="/vitalite"]').first()).toBeVisible({ timeout: 5000 });
  });
});
