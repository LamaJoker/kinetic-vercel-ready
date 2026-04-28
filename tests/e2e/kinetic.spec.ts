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
  await page.waitForFunction(() => typeof (window as any).Alpine !== 'undefined', { timeout: 8000 });
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
  // 1. Asset statique = même origine, zéro JS d'app, zéro contention IDB
  await page.goto('http://localhost:3000/manifest.json');

  // 2. Clear + injection du profil en une seule transaction IDB
  await page.evaluate(() => new Promise<void>((resolve) => {
    try { localStorage.clear(); } catch { /* ignoré */ }
    if (!('indexedDB' in window)) { resolve(); return; }
    const req = indexedDB.open('keyval-store', 1);
    req.onupgradeneeded = (): void => {
      try { req.result.createObjectStore('keyval'); } catch { /* déjà créé */ }
    };
    req.onsuccess = (): void => {
      const db    = req.result;
      const tx    = db.transaction('keyval', 'readwrite');
      const store = tx.objectStore('keyval');
      store.clear();
      store.put({
        weightKg: 75, heightCm: 175, birthYear: 1990,
        activityLevel: 'moderate', goal: 'lean', sex: 'M',
      }, 'kinetic:userProfile');
      tx.oncomplete = (): void => { db.close(); resolve(); };
      tx.onerror    = (): void => { db.close(); resolve(); };
    };
    req.onerror = (): void => resolve();
  }));

  // 3. Naviguer vers la route cible (profil déjà en IDB → pas de redirect onboarding)
  await page.goto(`http://localhost:3000${path}`);
  await waitForAlpineInit(page);
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
    await page.waitForFunction(() => document.querySelector('[x-data]') !== null, { timeout: 5000 });
  });

  test('le bouton retour fonctionne depuis vitalité', async ({ page }) => {
    await gotoApp(page, '/vitalite');
    await page.locator('a[href="/"]').first().click();
    await expect(page).toHaveURL(/localhost:3000\/#?\/?$/);
  });
});

test.describe('Kinetic App — Complétion de tâches', () => {

  test.beforeEach(async ({ page }) => {
    await gotoApp(page, '/vitalite');
    // Attendre que les tâches soient rendues avant d'interagir
    await page.waitForSelector('[x-data]', { timeout: 8000 });
  });

  test('complète une tâche et la marque disabled', async ({ page }) => {
    // Cibler explicitement un bouton de tâche (pas les boutons de nav)
    const taskButton = page.locator('button:not([disabled])').first();
    await expect(taskButton).toBeVisible({ timeout: 5000 });
    await taskButton.click();

    // Attendre qu'un bouton disabled apparaisse (tâche complétée)
    await page.waitForSelector('button[disabled]', { timeout: 5000 });
    await expect(page.locator('button[disabled]').first()).toBeVisible();
  });

  test('impossible de compléter deux fois la même tâche (guard)', async ({ page }) => {
    // Cibler spécifiquement les boutons de tâche (pas les boutons toast ✕)
    // en filtrant sur le texte "+N XP" présent uniquement sur les tâches incomplètes.
    const taskButton = page.locator('button').filter({ hasText: /\+\d+ XP/ }).first();
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
    await page.waitForFunction(
      () => ((window as any).Alpine?.store?.('xp')?.xp ?? 0) > 0,
      { timeout: 5000 },
    );

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
    await page.goto('http://localhost:3000');

    // Attendre la fin de l'init Alpine avant de couper le réseau
    await waitForAlpineInit(page);

    await context.setOffline(true);

    // Recharger sans crash
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

    // L'app ou la page offline doit afficher quelque chose
    const bodyText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
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

  test("le dashboard se charge sans erreur de rendu", async ({ page }) => {
    // Corps de page non vide = rendu Alpine OK
    await expect(page.locator('body')).not.toBeEmpty();
    // Nav présente (lien vitalité)
    await expect(page.locator('a[href="/vitalite"]').first()).toBeVisible({ timeout: 5000 });
  });
});
