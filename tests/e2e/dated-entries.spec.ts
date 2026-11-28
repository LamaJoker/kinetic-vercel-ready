/**
 * tests/e2e/dated-entries.spec.ts — saisies datées et annulation de séance.
 *
 * Parcours demandés par un utilisateur :
 *   1. pesée et mensurations à une date choisie, indépendante des valeurs ;
 *   2. séance lancée par erreur puis annulée : rien dans l'historique, même après rechargement ;
 *   3. saisie à une date passée (pesée, mensurations, séance) sans remplacer les jours suivants
 *      ni la valeur « actuelle ».
 *
 * Les dates sont calculées DANS la page (date locale du navigateur), jamais en UTC.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:3000';

test.skip(({ browserName }) => browserName !== 'chromium', 'Parcours couverts sur Chromium.');

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => 'Alpine' in window, {
    timeout: 10_000,
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kinetic:auth-ready')));
  await page.waitForFunction(
    () => (document.getElementById('app-outlet')?.childElementCount ?? 0) > 0,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(700);
}

async function goto(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding = true;
  });
  await page.goto(`${BASE}${path}`);
  await waitForApp(page);
}

/** Jour LOCAL du navigateur décalé de `offset` jours (« AAAA-MM-JJ »). */
async function localDay(page: Page, offset: number): Promise<string> {
  return page.evaluate((o) => {
    const d = new Date();
    d.setDate(d.getDate() + o);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }, offset);
}

/** Jour affiché par la page poids (« 27 nov. 26 »). */
async function bwLabel(page: Page, iso: string): Promise<string> {
  return page.evaluate((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    });
  }, iso);
}

test.describe('Pesées datées', () => {
  test('pesées d hier et d il y a un mois : rien n est remplacé, le poids actuel reste celui du jour', async ({
    page,
  }) => {
    await goto(page, '/bodyweight');
    const date = page.getByLabel('Date de la pesée');
    const weight = page.locator('input[x-model\\.number="newWeight"]');
    const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
    const today = await localDay(page, 0);
    const yesterday = await localDay(page, -1);
    const monthAgo = await localDay(page, -30);

    await expect(date).toHaveValue(today);
    await weight.fill('80');
    await save.click();
    await expect(page.getByText('80,0 kg').first()).toBeVisible();

    await date.fill(yesterday);
    await weight.fill('81');
    await save.click();
    await expect(page.getByRole('button', { name: 'Remplacer' })).toBeHidden();
    await expect(page.getByText('81,0 kg').first()).toBeVisible();
    // La date revient à aujourd'hui après l'enregistrement.
    await expect(date).toHaveValue(today);

    await date.fill(monthAgo);
    await weight.fill('82');
    await save.click();
    await expect(page.getByText('82,0 kg').first()).toBeVisible();

    const hero = page.locator('section.k-hero');
    // Le chiffre (x-count) ne s'anime qu'une fois visible : on l'amène à l'écran d'abord.
    await hero.scrollIntoViewIfNeeded();
    await expect(hero.getByText('Poids actuel')).toBeVisible();
    await expect(hero.locator('.k-stat')).toContainText('80,0');

    // Après rechargement : 3 pesées, poids actuel inchangé.
    await page.reload();
    await waitForApp(page);
    await page.getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(page.getByText('3 pesées', { exact: true })).toBeVisible();
    await expect(page.locator('section.k-hero .k-stat')).toContainText('80,0');
    for (const [iso, kg] of [
      [today, '80,0 kg'],
      [yesterday, '81,0 kg'],
      [monthAgo, '82,0 kg'],
    ] as const) {
      const row = page.locator('li.k-row').filter({ hasText: await bwLabel(page, iso) });
      await expect(row).toContainText(kg);
    }
  });

  test('même date : confirmation avant de remplacer ; date future refusée', async ({ page }) => {
    await goto(page, '/bodyweight');
    const date = page.getByLabel('Date de la pesée');
    const weight = page.locator('input[x-model\\.number="newWeight"]');
    const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
    const yesterday = await localDay(page, -1);

    await date.fill(yesterday);
    await weight.fill('75');
    await save.click();
    await expect(page.getByText('75,0 kg').first()).toBeVisible();

    await date.fill(yesterday);
    await weight.fill('76');
    await save.click();
    await expect(page.getByText(/Une pesée existe déjà le/)).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).first().click();
    await expect(page.getByText('76,0 kg')).toHaveCount(0);

    await save.click();
    await page.getByRole('button', { name: 'Remplacer' }).click();
    await expect(page.getByText('76,0 kg').first()).toBeVisible();
    await expect(page.getByText('75,0 kg')).toHaveCount(0);
    await expect(page.getByText('1 pesée', { exact: true })).toBeVisible();

    await date.fill(await localDay(page, 1));
    await weight.fill('77');
    await expect(page.getByText('La date ne peut pas être dans le futur.')).toBeVisible();
    await expect(save).toBeDisabled();
  });
});

test.describe('Mensurations datées', () => {
  test('mesures à une date passée : les mesures du jour restent les plus récentes', async ({
    page,
  }) => {
    await goto(page, '/mensurations');
    const date = page.getByLabel('Date des mesures');
    const waist = page.locator('input[x-model\\.number="fWaist"]');
    const save = page.getByRole('button', { name: 'Enregistrer les mensurations' });
    const today = await localDay(page, 0);

    await expect(date).toHaveValue(today);
    await waist.fill('80');
    await save.click();
    await expect(page.locator('ul.k-list li')).toHaveCount(1);

    await date.fill(await localDay(page, -10));
    await waist.fill('84');
    await save.click();
    await expect(page.getByRole('button', { name: 'Compléter' })).toBeHidden();

    await page.reload();
    await waitForApp(page);
    const rows = page.locator('ul.k-list li');
    await expect(rows).toHaveCount(2);
    // Historique du plus récent au plus ancien : aujourd'hui (80) puis il y a 10 jours (84).
    await expect(rows.nth(0)).toContainText('80');
    await expect(rows.nth(1)).toContainText('84');
    await expect(waist).toHaveAttribute('placeholder', /80/);

    // Même date qu'une mesure existante : confirmation « Compléter ».
    await date.fill(await localDay(page, -10));
    await page.locator('input[x-model\\.number="fChest"]').fill('100');
    await save.click();
    await page.getByRole('button', { name: 'Compléter' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('84');
    await expect(rows.nth(1)).toContainText('100');
  });
});

test.describe('Séances', () => {
  test('séance lancée puis annulée : rien dans l historique, même après rechargement', async ({
    page,
  }) => {
    await goto(page, '/');
    await page.getByRole('button', { name: 'Commencer la séance' }).click();
    await page.waitForURL('**/seances', { timeout: 10_000 });
    await waitForApp(page);
    const addSet = page.getByRole('button', { name: '+ Série' }).first();
    await addSet.click();
    const skip = page.getByRole('button', { name: 'Passer' });
    await page.waitForTimeout(300);
    if (await skip.isVisible()) await skip.click();

    await page.getByRole('button', { name: 'Annuler la séance' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: 'Annuler la séance ?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Continuer la séance' }).click();
    await expect(dialog).toBeHidden();

    // Aussi depuis le mode salle : la confirmation passe au-dessus.
    await page.getByRole('button', { name: 'Mode salle : écran grand format' }).click();
    const gym = page.getByRole('region', { name: 'Mode salle' });
    await expect(gym).toBeVisible();
    await gym.getByRole('button', { name: 'Annuler la séance' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Continuer la séance' }).click();
    await expect(dialog).toBeHidden();
    await gym.getByRole('button', { name: 'Quitter le mode salle' }).click();
    await expect(gym).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Séance en cours' })).toBeVisible();

    await page.getByRole('button', { name: 'Annuler la séance' }).first().click();
    await dialog.getByRole('button', { name: 'Annuler la séance' }).click();
    await expect(page.getByRole('heading', { name: 'Séance en cours' })).toBeHidden();
    await expect(page.getByText('Aucune séance enregistrée.')).toBeVisible();

    await page.reload();
    await waitForApp(page);
    await expect(page.getByRole('heading', { name: 'Séance en cours' })).toBeHidden();
    await expect(page.getByText('Aucune séance enregistrée.')).toBeVisible();
    await page.goto(`${BASE}/`);
    await waitForApp(page);
    await expect(page.getByRole('button', { name: 'Commencer la séance' })).toBeVisible();
  });

  test('séance passée ajoutée : visible à sa date, la séance du jour reste intacte', async ({
    page,
  }) => {
    // Une séance aujourd'hui.
    await goto(page, '/');
    await page.getByRole('button', { name: 'Commencer la séance' }).click();
    await page.waitForURL('**/seances', { timeout: 10_000 });
    await waitForApp(page);
    const addSet = page.getByRole('button', { name: '+ Série' }).first();
    const skip = page.getByRole('button', { name: 'Passer' });
    for (let i = 0; i < 2; i++) {
      await addSet.click();
      await page.waitForTimeout(300);
      if (await skip.isVisible()) await skip.click();
    }
    await page.getByRole('button', { name: 'Sauver' }).click();
    await expect(page.getByText('1 séance', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Séance passée il y a 3 jours, séance libre.
    const pastDay = await localDay(page, -3);
    await page.getByRole('button', { name: '+ Ajouter une séance passée' }).click();
    const sheet = page.getByRole('dialog', { name: 'Séance passée' });
    await expect(sheet.getByLabel('Date')).toHaveValue(await localDay(page, 0));
    await sheet.getByLabel('Date').fill(await localDay(page, 1));
    await sheet.getByLabel('Heure de début').fill('10:00');
    await sheet.getByRole('button', { name: 'Saisir les exercices' }).click();
    await expect(sheet.getByRole('alert')).toContainText('futur');

    await sheet.getByLabel('Date').fill(pastDay);
    await sheet.getByLabel('Heure de début').fill('18:30');
    await sheet.getByLabel('Durée (min)').fill('45');
    await sheet.getByRole('button', { name: 'Saisir les exercices' }).click();
    await expect(sheet).toBeHidden();

    const exercise = page.getByLabel('Exercice à ajouter').filter({ visible: true });
    const firstValue = await exercise
      .locator('option')
      .nth(1)
      .evaluate((o) => (o as HTMLOptionElement).value);
    await exercise.selectOption(firstValue);
    await page
      .getByRole('button', { name: 'Ajouter', exact: true })
      .filter({ visible: true })
      .click();
    const setSheet = page.getByRole('dialog').filter({ has: page.locator('#set-edit-kg') });
    await setSheet.locator('#set-edit-kg').fill('60');
    await setSheet.locator('#set-edit-reps').fill('8');
    await setSheet.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(setSheet).toBeHidden();
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByText('2 séances', { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.reload();
    await waitForApp(page);
    await expect(page.getByText('2 séances', { exact: true })).toBeVisible();
    // Historique du plus récent au plus ancien : la séance du jour reste en tête.
    const items = page.locator('[id^="history-"]');
    await expect(items).toHaveCount(2);
    const pastLabel = await page.evaluate((s) => {
      const [y, m, d] = s.split('-').map(Number) as [number, number, number];
      return String(new Date(y, m - 1, d).getDate());
    }, pastDay);
    await expect(items.nth(1).locator('.font-display').first()).toHaveText(pastLabel);
    await expect(items.nth(1)).toContainText('45 min');
    await expect(items.nth(0)).not.toContainText('45 min');
  });
});
