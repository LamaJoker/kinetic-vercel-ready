import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'android') },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: () => undefined } }));
vi.mock('../../apps/web/src/lib/barcode-camera', () => ({
  cameraScanSupported: () => false,
  scanBarcodeWithCamera: vi.fn(),
}));

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { STORAGE_KEYS, normalizeRecipes, recipePerServing, type MealLog } from '@kinetic/core';
import { getDeps } from '../../apps/web/src/deps.js';
import { PROTEIN_NOTIF_ID } from '../../apps/web/src/lib/reminders.js';
import { syncProteinReminder } from '../../apps/web/src/lib/protein-reminder.js';
import { isBackedUpKey } from '../../apps/web/src/lib/backup.js';
import { buildDemoData } from '../../apps/web/src/lib/demo.js';
import { mealSectionViews } from '../../apps/web/src/pages/nutrition.page.js';
import { InMemoryStorage } from '../helpers/stubs.js';

const chicken = {
  name: 'Blanc de poulet',
  kcalPer100: 110,
  proteinPer100: 23,
  carbsPer100: 0,
  fatPer100: 1.5,
};
const log = (grams: number): MealLog[] => [
  { id: 'm', mealName: 'Déjeuner', loggedAt: '', items: [{ food: chicken, grams }] },
];

describe('nutrition : sauvegarde et démo', () => {
  it('récents, favoris, recettes et réglages partent dans la sauvegarde', () => {
    for (const key of [
      STORAGE_KEYS.NUTRITION_RECENTS,
      STORAGE_KEYS.NUTRITION_FAVORITES,
      STORAGE_KEYS.NUTRITION_RECIPES,
      STORAGE_KEYS.NUTRITION_PREFS,
    ])
      expect(isBackedUpKey(key)).toBe(true);
  });

  it('la démo montre des récents, des favoris, 2 recettes et le journal d’hier', () => {
    const now = new Date(2026, 10, 21, 12, 0);
    const values = new Map<string, unknown>(buildDemoData(now).values);
    expect((values.get(STORAGE_KEYS.NUTRITION_RECENTS) as unknown[]).length).toBeGreaterThan(5);
    expect((values.get(STORAGE_KEYS.NUTRITION_FAVORITES) as unknown[]).length).toBeGreaterThan(1);
    const recipes = normalizeRecipes(values.get(STORAGE_KEYS.NUTRITION_RECIPES));
    expect(recipes).toHaveLength(2);
    expect(recipes.every((r) => recipePerServing(r).kcal > 0)).toBe(true);
    const yesterday = values.get(STORAGE_KEYS.NUTRITION_LOG('2026-11-20')) as MealLog[];
    expect(yesterday.map((m) => m.mealName)).toEqual(['Matin', 'Déjeuner', 'Collation', 'Dîner']);
  });
});

describe('journal par repas (vue)', () => {
  it('anneau violet et « Copier le repas d’hier » seulement si hier a ce repas', () => {
    const views = mealSectionViews(log(100), log(150), 40);
    const lunch = views.find((v) => v.mealName === 'Déjeuner')!;
    expect(lunch.ringStyle).toBe('--p: 57');
    expect(lunch.canCopyYesterday).toBe(true);
    expect(lunch.proteinAria).toBe('Protéines : 23 sur 40 g');
    expect(views.find((v) => v.mealName === 'Dîner')!.canCopyYesterday).toBe(false);
  });
});

describe('rappel « protéines du soir »', () => {
  let storage: InMemoryStorage;
  const now = new Date(2026, 10, 21, 14, 0);

  beforeEach(async () => {
    vi.clearAllMocks();
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue({ storage } as never);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({
      display: 'granted',
    } as never);
    vi.mocked(LocalNotifications.cancel).mockResolvedValue(undefined);
    vi.mocked(LocalNotifications.schedule).mockResolvedValue({ notifications: [] });
    await storage.set(STORAGE_KEYS.NUTRITION_PLAN, { macros: { proteinG: 170 } });
  });

  it('programme « Il te manque … » à 20 h avec un id libre', async () => {
    await storage.set(STORAGE_KEYS.NUTRITION_LOG('2026-11-21'), log(400)); // 92 g
    await syncProteinReminder(now);
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: PROTEIN_NOTIF_ID }],
    });
    const n = vi.mocked(LocalNotifications.schedule).mock.calls[0]![0].notifications[0]!;
    expect(n.id).toBe(PROTEIN_NOTIF_ID);
    expect(n.body).toBe("Il te manque 78 g de protéines aujourd'hui");
    expect(n.schedule?.at).toEqual(new Date(2026, 10, 21, 20, 0));
    expect([1001, 1002, 1003, 1004, 1005]).not.toContain(PROTEIN_NOTIF_ID);
  });

  it('aucune notification si l’objectif est atteint ou le rappel coupé', async () => {
    await storage.set(STORAGE_KEYS.NUTRITION_LOG('2026-11-21'), log(800)); // 184 g
    await syncProteinReminder(now);
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();

    await storage.set(STORAGE_KEYS.NUTRITION_LOG('2026-11-21'), log(100));
    await storage.set(STORAGE_KEYS.NUTRITION_PREFS, { proteinReminder: false });
    await syncProteinReminder(now);
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('ne fait rien sur le web', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await syncProteinReminder(now);
    expect(LocalNotifications.cancel).not.toHaveBeenCalled();
  });
});
