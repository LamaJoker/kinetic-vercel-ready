import { describe, expect, it } from 'vitest';
import {
  appendToMeal,
  copyableMeals,
  DEFAULT_NUTRITION_PREFS,
  foodKey,
  isFavorite,
  lastGramsFor,
  MAX_RECENT_FOODS,
  MEAL_SLOTS,
  mealPortions,
  mealProteinTarget,
  mealSections,
  mealSlotForHour,
  normalizeFavorites,
  normalizeNutritionPrefs,
  normalizeRecents,
  normalizeRecipes,
  planProteinReminder,
  portionSummary,
  proteinReminderBody,
  proteinShortfall,
  pushRecent,
  recipePerServing,
  recipeServingPortion,
  recipeTotals,
  removeRecipe,
  sanitizeFood,
  shiftIsoDate,
  sumMacros,
  toggleFavorite,
  upsertRecipe,
  validateRecipe,
  type FoodPer100,
  type MealLog,
  type Recipe,
} from '../../packages/core/src/index';

const chicken: FoodPer100 = {
  name: 'Blanc de poulet',
  kcalPer100: 110,
  proteinPer100: 23,
  carbsPer100: 0,
  fatPer100: 1.5,
};
const rice: FoodPer100 = {
  name: 'Riz basmati cuit',
  kcalPer100: 130,
  proteinPer100: 2.7,
  carbsPer100: 28,
  fatPer100: 0.3,
};
const skyr: FoodPer100 = {
  name: 'Skyr nature',
  kcalPer100: 63,
  proteinPer100: 11,
  carbsPer100: 4,
  fatPer100: 0.2,
};

const bowl: Recipe = {
  id: 'r1',
  name: 'Bowl poulet riz',
  servings: 2,
  ingredients: [
    { food: chicken, grams: 300 },
    { food: rice, grams: 400 },
  ],
  updatedAt: '2026-11-01T12:00:00.000Z',
};

describe('aliments', () => {
  it('identifie un aliment par son nom, sans casse ni espaces', () => {
    expect(foodKey({ name: '  Skyr   NATURE ' })).toBe(foodKey(skyr));
  });

  it('nettoie un aliment et refuse un nom vide', () => {
    expect(sanitizeFood({ name: ' Pomme ', kcalPer100: -3, proteinPer100: 'x' })).toEqual({
      name: 'Pomme',
      kcalPer100: 0,
      proteinPer100: 0,
      carbsPer100: 0,
      fatPer100: 0,
    });
    expect(sanitizeFood({ name: '  ' })).toBeNull();
    expect(sanitizeFood(null)).toBeNull();
  });

  it('additionne les macros et résume une portion', () => {
    const m = sumMacros([
      { food: chicken, grams: 200 },
      { food: rice, grams: 100 },
    ]);
    expect(m).toEqual({ kcal: 350, proteinG: 48.7, carbsG: 28, fatG: 3.3 });
    expect(portionSummary({ food: chicken, grams: 180 })).toBe('180 g · 198 kcal · P 41 g');
  });
});

describe('récents', () => {
  it('met le dernier aliment en tête avec sa dernière quantité, sans doublon', () => {
    let r = pushRecent([], { food: chicken, grams: 150 }, '2026-11-20T12:00:00Z');
    r = pushRecent(r, { food: rice, grams: 200 }, '2026-11-20T12:01:00Z');
    r = pushRecent(
      r,
      { food: { ...chicken, name: 'blanc de poulet' }, grams: 180 },
      '2026-11-21T12:00:00Z',
    );
    expect(r.map((x) => x.grams)).toEqual([180, 200]);
    expect(lastGramsFor(r, chicken)).toBe(180);
    expect(lastGramsFor(r, skyr)).toBe(100);
  });

  it('borne la liste et ignore les portions invalides', () => {
    let r = pushRecent([], { food: chicken, grams: 0 }, 'x');
    expect(r).toEqual([]);
    for (let i = 0; i < MAX_RECENT_FOODS + 5; i++)
      r = pushRecent(r, { food: { ...rice, name: `Aliment ${i}` }, grams: 10 }, `t${i}`);
    expect(r).toHaveLength(MAX_RECENT_FOODS);
    expect(r[0]!.food.name).toBe(`Aliment ${MAX_RECENT_FOODS + 4}`);
  });

  it('relit le stockage : tri du plus récent, doublons et déchets écartés', () => {
    const r = normalizeRecents([
      { food: rice, grams: 200, usedAt: '2026-11-19' },
      { food: chicken, grams: 150, usedAt: '2026-11-21' },
      { food: rice, grams: 50, usedAt: '2026-11-18' },
      { nope: true },
    ]);
    expect(r.map((x) => x.food.name)).toEqual(['Blanc de poulet', 'Riz basmati cuit']);
    expect(normalizeRecents('x')).toEqual([]);
  });
});

describe('favoris', () => {
  it('épingle puis retire', () => {
    const once = toggleFavorite([], skyr);
    expect(isFavorite(once, { ...skyr, name: 'SKYR nature' })).toBe(true);
    const twice = toggleFavorite(once, skyr);
    expect(twice).toEqual([]);
  });

  it('relit le stockage sans doublon', () => {
    expect(normalizeFavorites([skyr, skyr, { name: '' }, chicken])).toHaveLength(2);
    expect(normalizeFavorites(undefined)).toEqual([]);
  });
});

describe('recettes', () => {
  it('calcule les totaux et les macros par portion', () => {
    expect(recipeTotals(bowl)).toEqual({
      grams: 700,
      kcal: 850,
      proteinG: 79.8,
      carbsG: 112,
      fatG: 5.7,
    });
    expect(recipePerServing(bowl)).toEqual({
      grams: 350,
      kcal: 425,
      proteinG: 39.9,
      carbsG: 56,
      fatG: 2.9,
    });
  });

  it('transforme une portion en aliment du journal aux mêmes macros', () => {
    const p = recipeServingPortion(bowl)!;
    expect(p.grams).toBe(350);
    expect(p.food.recipeId).toBe('r1');
    expect(p.food.name).toBe('Bowl poulet riz');
    const m = sumMacros([p]);
    expect(m.kcal).toBe(425);
    expect(m.proteinG).toBeCloseTo(39.9, 1);
    expect(recipeServingPortion(bowl, 2)!.grams).toBe(700);
    expect(recipeServingPortion({ ...bowl, ingredients: [] })).toBeNull();
  });

  it('valide nom, portions et ingrédients', () => {
    expect(validateRecipe(bowl)).toBeNull();
    expect(validateRecipe({ ...bowl, name: ' ' })).toBe('Donne un nom à ta recette.');
    expect(validateRecipe({ ...bowl, servings: 0 })).toMatch(/portions/);
    expect(validateRecipe({ ...bowl, ingredients: [] })).toMatch(/ingrédient/);
    expect(validateRecipe({ ...bowl, ingredients: [{ food: rice, grams: 0 }] })).toMatch(
      /quantité/,
    );
  });

  it('ajoute, modifie et supprime', () => {
    const porridge: Recipe = { ...bowl, id: 'r2', name: 'Avoine' };
    let list = upsertRecipe([], bowl);
    list = upsertRecipe(list, porridge);
    expect(list.map((r) => r.name)).toEqual(['Avoine', 'Bowl poulet riz']);
    list = upsertRecipe(list, { ...bowl, servings: 3 });
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.id === 'r1')!.servings).toBe(3);
    expect(removeRecipe(list, 'r2').map((r) => r.id)).toEqual(['r1']);
  });

  it('relit le stockage', () => {
    const list = normalizeRecipes([
      bowl,
      { id: 'x' },
      { ...bowl, id: 'r3', name: 'Zz', servings: -1 },
    ]);
    expect(list.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(list[1]!.servings).toBe(1);
  });
});

describe('copier un repas', () => {
  const yesterday: MealLog[] = [
    {
      id: 'a',
      mealName: 'Déjeuner',
      loggedAt: '2026-11-20T12:00:00Z',
      items: [
        { food: chicken, grams: 180 },
        { food: rice, grams: 200 },
      ],
    },
    { id: 'b', mealName: 'Dîner', loggedAt: '2026-11-20T20:00:00Z', items: [] },
  ];

  it('liste les repas non vides d’un jour', () => {
    const meals = copyableMeals(yesterday);
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({
      mealName: 'Déjeuner',
      count: 2,
      preview: 'Blanc de poulet, Riz basmati cuit',
    });
  });

  it('ajoute à un repas existant ou le crée, sans modifier l’original', () => {
    const today: MealLog[] = [
      { id: 't', mealName: 'Déjeuner', loggedAt: 'x', items: [{ food: skyr, grams: 100 }] },
    ];
    const portions = mealPortions(yesterday, 'Déjeuner');
    const merged = appendToMeal(today, 'Déjeuner', portions, { id: 'n', at: 'now' });
    expect(merged[0]!.items).toHaveLength(3);
    expect(today[0]!.items).toHaveLength(1);
    const created = appendToMeal(today, 'Dîner', portions, { id: 'n', at: 'now' });
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ id: 'n', mealName: 'Dîner', loggedAt: 'now' });
    expect(appendToMeal(today, 'Dîner', [], { id: 'n', at: 'now' })).toHaveLength(1);
  });

  it('décale une date locale', () => {
    expect(shiftIsoDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftIsoDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('propose le repas selon l’heure', () => {
    expect(mealSlotForHour(7)).toBe('Matin');
    expect(mealSlotForHour(12)).toBe('Déjeuner');
    expect(mealSlotForHour(16)).toBe('Collation');
    expect(mealSlotForHour(21)).toBe('Dîner');
  });
});

describe('protéines réparties', () => {
  it('divise l’objectif du jour par le nombre de repas, ou prend le réglage manuel', () => {
    expect(mealProteinTarget(170, DEFAULT_NUTRITION_PREFS)).toBe(43);
    expect(mealProteinTarget(170, { ...DEFAULT_NUTRITION_PREFS, mealsPerDay: 5 })).toBe(34);
    expect(mealProteinTarget(170, { ...DEFAULT_NUTRITION_PREFS, proteinPerMealG: 40 })).toBe(40);
    expect(mealProteinTarget(0, DEFAULT_NUTRITION_PREFS)).toBe(0);
  });

  it('normalise les réglages', () => {
    expect(normalizeNutritionPrefs(null)).toEqual(DEFAULT_NUTRITION_PREFS);
    expect(
      normalizeNutritionPrefs({
        mealsPerDay: 99,
        proteinPerMealG: 0,
        proteinReminder: false,
        proteinReminderTime: '25:00',
        proteinReminderMinG: 30,
      }),
    ).toEqual({ ...DEFAULT_NUTRITION_PREFS, proteinReminder: false, proteinReminderMinG: 30 });
    expect(normalizeNutritionPrefs({ proteinPerMealG: 38.6 }).proteinPerMealG).toBe(39);
  });

  it('construit les sections du journal : repas habituels + autres', () => {
    const log: MealLog[] = [
      { id: '1', mealName: 'Déjeuner', loggedAt: '', items: [{ food: chicken, grams: 200 }] },
      { id: '2', mealName: 'Brunch', loggedAt: '', items: [{ food: skyr, grams: 100 }] },
    ];
    const s = mealSections(log, MEAL_SLOTS, 40);
    expect(s.map((x) => x.mealName)).toEqual(['Matin', 'Déjeuner', 'Collation', 'Dîner', 'Brunch']);
    const lunch = s[1]!;
    expect(lunch).toMatchObject({
      proteinG: 46,
      pct: 100,
      reached: true,
      proteinLabel: '46 / 40 g',
    });
    expect(lunch.items[0]!.idx).toBe(0);
    expect(s[0]).toMatchObject({ pct: 0, reached: false, items: [] });
  });

  it('calcule le manque', () => {
    expect(proteinShortfall(135, 170)).toBe(35);
    expect(proteinShortfall(180, 170)).toBe(0);
    expect(proteinReminderBody(35)).toBe("Il te manque 35 g de protéines aujourd'hui");
  });

  describe('rappel du soir', () => {
    const base = {
      now: new Date(2026, 10, 21, 14, 0),
      prefs: DEFAULT_NUTRITION_PREFS,
      consumedG: 135,
      targetG: 170,
      loggedToday: true,
    };

    it('le programme aujourd’hui à 20 h avec le manque', () => {
      const plan = planProteinReminder(base)!;
      expect(plan.at).toEqual(new Date(2026, 10, 21, 20, 0));
      expect(plan.missingG).toBe(35);
      expect(plan.body).toBe("Il te manque 35 g de protéines aujourd'hui");
    });

    it('respecte l’heure réglée', () => {
      const plan = planProteinReminder({
        ...base,
        prefs: { ...DEFAULT_NUTRITION_PREFS, proteinReminderTime: '21:30' },
      })!;
      expect(plan.at).toEqual(new Date(2026, 10, 21, 21, 30));
    });

    it('rien si l’objectif est atteint, sous le seuil, désactivé, non suivi ou l’heure passée', () => {
      expect(planProteinReminder({ ...base, consumedG: 170 })).toBeNull();
      expect(planProteinReminder({ ...base, consumedG: 150 })).toBeNull(); // manque 20 = seuil
      expect(
        planProteinReminder({
          ...base,
          prefs: { ...DEFAULT_NUTRITION_PREFS, proteinReminder: false },
        }),
      ).toBeNull();
      expect(planProteinReminder({ ...base, loggedToday: false })).toBeNull();
      expect(planProteinReminder({ ...base, targetG: 0 })).toBeNull();
      expect(planProteinReminder({ ...base, now: new Date(2026, 10, 21, 20, 30) })).toBeNull();
    });
  });
});
