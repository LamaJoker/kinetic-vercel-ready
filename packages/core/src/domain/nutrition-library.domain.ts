/**
 * Nutrition — aliments récents, favoris, recettes, copie de repas et protéines
 * réparties sur la journée. Logique pure (aucune I/O) : la page Nutrition et le
 * rappel du soir (lib/protein-reminder.ts) s'appuient dessus.
 *
 * Les valeurs nutritionnelles sont toujours exprimées pour 100 g, comme le journal :
 * une portion de recette devient un « aliment » dont les macros pour 100 g sont
 * celles du mélange, et dont la quantité est le poids d'une portion.
 */

export interface FoodPer100 {
  name: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
  /** Présent si l'aliment est une portion de recette. */
  recipeId?: string;
}

export interface FoodPortion {
  food: FoodPer100;
  grams: number;
}

export interface RecentFood extends FoodPortion {
  /** Date ISO de la dernière utilisation. */
  usedAt: string;
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  ingredients: FoodPortion[];
  updatedAt: string;
}

/** Repas du journal (même forme que le journal stocké). */
export interface MealLog {
  id: string;
  mealName: string;
  items: FoodPortion[];
  loggedAt: string;
}

export interface Macros {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface NutritionPrefs {
  /** Nombre de repas par jour qui se partagent l'objectif de protéines. */
  mealsPerDay: number;
  /** Objectif par repas choisi à la main (g), null = objectif du jour ÷ nombre de repas. */
  proteinPerMealG: number | null;
  /** Rappel du soir s'il manque des protéines. */
  proteinReminder: boolean;
  /** Heure locale « HH:MM ». */
  proteinReminderTime: string;
  /** Pas de rappel s'il manque ce nombre de grammes ou moins. */
  proteinReminderMinG: number;
}

export const DEFAULT_NUTRITION_PREFS: NutritionPrefs = {
  mealsPerDay: 4,
  proteinPerMealG: null,
  proteinReminder: true,
  proteinReminderTime: '20:00',
  proteinReminderMinG: 20,
};

/** Repas proposés dans le journal, dans l'ordre de la journée. */
export const MEAL_SLOTS = ['Matin', 'Déjeuner', 'Collation', 'Dîner'] as const;

/** Repas le plus probable à cette heure (pré-choisi dans « Ajouter »). */
export function mealSlotForHour(hour: number): (typeof MEAL_SLOTS)[number] {
  if (hour < 11) return 'Matin';
  if (hour < 15) return 'Déjeuner';
  if (hour < 18) return 'Collation';
  return 'Dîner';
}

export const MAX_RECENT_FOODS = 12;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clé d'identité d'un aliment : son nom, sans casse ni espaces superflus. */
export function foodKey(food: Pick<FoodPer100, 'name'>): string {
  return (food.name ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR');
}

/** Aliment propre (copie sans proxy, valeurs ≥ 0) ou null s'il n'a pas de nom. */
export function sanitizeFood(raw: unknown): FoodPer100 | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<Record<keyof FoodPer100, unknown>>;
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (!name) return null;
  const food: FoodPer100 = {
    name,
    kcalPer100: num(f.kcalPer100),
    proteinPer100: num(f.proteinPer100),
    carbsPer100: num(f.carbsPer100),
    fatPer100: num(f.fatPer100),
  };
  if (typeof f.recipeId === 'string' && f.recipeId) food.recipeId = f.recipeId;
  return food;
}

/** Portion propre ou null (aliment invalide, quantité ≤ 0). */
export function sanitizePortion(raw: unknown): FoodPortion | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as { food?: unknown; grams?: unknown };
  const food = sanitizeFood(p.food);
  const grams = num(p.grams);
  return food && grams > 0 ? { food, grams } : null;
}

export function portionMacros(p: FoodPortion): Macros {
  const f = p.grams / 100;
  return {
    kcal: p.food.kcalPer100 * f,
    proteinG: p.food.proteinPer100 * f,
    carbsG: p.food.carbsPer100 * f,
    fatG: p.food.fatPer100 * f,
  };
}

/** Somme des macros (kcal arrondies, grammes au dixième). */
export function sumMacros(portions: readonly FoodPortion[]): Macros {
  const t = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const p of portions) {
    const m = portionMacros(p);
    t.kcal += m.kcal;
    t.proteinG += m.proteinG;
    t.carbsG += m.carbsG;
    t.fatG += m.fatG;
  }
  return {
    kcal: Math.round(t.kcal),
    proteinG: round1(t.proteinG),
    carbsG: round1(t.carbsG),
    fatG: round1(t.fatG),
  };
}

/** « 120 g · 245 kcal · P 30 g » */
export function portionSummary(p: FoodPortion): string {
  const m = portionMacros(p);
  return `${Math.round(p.grams)} g · ${Math.round(m.kcal)} kcal · P ${Math.round(m.proteinG)} g`;
}

// ─── Récents ────────────────────────────────────────────────────────────────

/** Place l'aliment en tête des récents (une seule fois par nom), avec sa dernière quantité. */
export function pushRecent(
  recents: readonly RecentFood[],
  portion: FoodPortion,
  usedAt: string,
  max = MAX_RECENT_FOODS,
): RecentFood[] {
  const clean = sanitizePortion(portion);
  if (!clean) return recents.slice(0, max);
  const key = foodKey(clean.food);
  return [
    { ...clean, usedAt },
    ...recents.filter((r) => foodKey(r.food) !== key).map((r) => ({ ...r })),
  ].slice(0, max);
}

/** Récents lus depuis le stockage : entrées invalides écartées, les plus récents d'abord. */
export function normalizeRecents(raw: unknown): RecentFood[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentFood[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const p = sanitizePortion(r);
    if (!p) continue;
    const key = foodKey(p.food);
    if (seen.has(key)) continue;
    seen.add(key);
    const usedAt = (r as { usedAt?: unknown }).usedAt;
    out.push({ ...p, usedAt: typeof usedAt === 'string' ? usedAt : '' });
  }
  return out
    .sort((a, b) => (a.usedAt < b.usedAt ? 1 : a.usedAt > b.usedAt ? -1 : 0))
    .slice(0, MAX_RECENT_FOODS);
}

/** Dernière quantité utilisée pour cet aliment (100 g par défaut). */
export function lastGramsFor(recents: readonly RecentFood[], food: FoodPer100): number {
  const key = foodKey(food);
  return recents.find((r) => foodKey(r.food) === key)?.grams ?? 100;
}

// ─── Favoris ────────────────────────────────────────────────────────────────

export function isFavorite(favorites: readonly FoodPer100[], food: FoodPer100): boolean {
  const key = foodKey(food);
  return favorites.some((f) => foodKey(f) === key);
}

/** Épingle l'aliment (en tête) ou le retire s'il l'était déjà. */
export function toggleFavorite(favorites: readonly FoodPer100[], food: FoodPer100): FoodPer100[] {
  const clean = sanitizeFood(food);
  if (!clean) return favorites.map((f) => ({ ...f }));
  const key = foodKey(clean);
  const rest = favorites.filter((f) => foodKey(f) !== key).map((f) => ({ ...f }));
  return rest.length < favorites.length ? rest : [clean, ...rest];
}

export function normalizeFavorites(raw: unknown): FoodPer100[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FoodPer100[] = [];
  for (const r of raw) {
    const f = sanitizeFood(r);
    if (!f || seen.has(foodKey(f))) continue;
    seen.add(foodKey(f));
    out.push(f);
  }
  return out;
}

// ─── Recettes ───────────────────────────────────────────────────────────────

export interface RecipeServing extends Macros {
  /** Poids d'une portion (g). */
  grams: number;
}

export function recipeTotals(recipe: Pick<Recipe, 'ingredients'>): RecipeServing {
  const grams = recipe.ingredients.reduce((s, i) => s + num(i.grams), 0);
  return { ...sumMacros(recipe.ingredients), grams: Math.round(grams) };
}

/** Macros et poids d'une portion (recette ÷ nombre de portions). */
export function recipePerServing(recipe: Pick<Recipe, 'ingredients' | 'servings'>): RecipeServing {
  const servings = Math.max(1, Math.round(num(recipe.servings)) || 1);
  const t = recipeTotals(recipe);
  return {
    grams: Math.round(t.grams / servings),
    kcal: Math.round(t.kcal / servings),
    proteinG: round1(t.proteinG / servings),
    carbsG: round1(t.carbsG / servings),
    fatG: round1(t.fatG / servings),
  };
}

/**
 * Portion(s) de recette prête(s) à ajouter au journal : un aliment « recette »
 * (macros du mélange pour 100 g) et le poids correspondant. null si la recette est vide.
 */
export function recipeServingPortion(
  recipe: Pick<Recipe, 'id' | 'name' | 'ingredients' | 'servings'>,
  servings = 1,
): FoodPortion | null {
  const totalGrams = recipe.ingredients.reduce((s, i) => s + num(i.grams), 0);
  if (!(totalGrams > 0) || !(servings > 0)) return null;
  const raw = recipe.ingredients.reduce(
    (t, i) => {
      const m = portionMacros(i);
      return {
        kcal: t.kcal + m.kcal,
        proteinG: t.proteinG + m.proteinG,
        carbsG: t.carbsG + m.carbsG,
        fatG: t.fatG + m.fatG,
      };
    },
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
  const per100 = 100 / totalGrams;
  const count = Math.max(1, Math.round(num(recipe.servings)) || 1);
  return {
    food: {
      name: recipe.name.trim(),
      kcalPer100: Math.round(raw.kcal * per100 * 10) / 10,
      proteinPer100: Math.round(raw.proteinG * per100 * 100) / 100,
      carbsPer100: Math.round(raw.carbsG * per100 * 100) / 100,
      fatPer100: Math.round(raw.fatG * per100 * 100) / 100,
      recipeId: recipe.id,
    },
    grams: Math.round((totalGrams / count) * servings),
  };
}

/** Message d'erreur (français) si la recette est incomplète, sinon null. */
export function validateRecipe(
  recipe: Pick<Recipe, 'name' | 'servings' | 'ingredients'>,
): string | null {
  if (!recipe.name.trim()) return 'Donne un nom à ta recette.';
  if (!Number.isInteger(recipe.servings) || recipe.servings < 1 || recipe.servings > 50)
    return 'Nombre de portions entre 1 et 50.';
  if (recipe.ingredients.length === 0) return 'Ajoute au moins un ingrédient.';
  if (recipe.ingredients.some((i) => !(num(i.grams) > 0)))
    return 'Chaque ingrédient doit avoir une quantité (g).';
  return null;
}

/** Ajoute ou remplace la recette (même id), triée par nom. */
export function upsertRecipe(recipes: readonly Recipe[], recipe: Recipe): Recipe[] {
  return [...recipes.filter((r) => r.id !== recipe.id), recipe].sort((a, b) =>
    a.name.localeCompare(b.name, 'fr'),
  );
}

export function removeRecipe(recipes: readonly Recipe[], id: string): Recipe[] {
  return recipes.filter((r) => r.id !== id);
}

export function normalizeRecipes(raw: unknown): Recipe[] {
  if (!Array.isArray(raw)) return [];
  const out: Recipe[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Partial<Record<keyof Recipe, unknown>>;
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || !x.name.trim()) continue;
    const ingredients = Array.isArray(x.ingredients)
      ? x.ingredients.map(sanitizePortion).filter((p): p is FoodPortion => p !== null)
      : [];
    const servings = Math.max(1, Math.round(num(x.servings)) || 1);
    out.push({
      id: x.id,
      name: x.name.trim(),
      servings,
      ingredients,
      updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

// ─── Journal : copier un repas ──────────────────────────────────────────────

/** Copie (sans proxy) des aliments d'un repas du journal. */
export function mealPortions(log: readonly MealLog[], mealName: string): FoodPortion[] {
  return log
    .filter((m) => m.mealName === mealName)
    .flatMap((m) => m.items)
    .map(sanitizePortion)
    .filter((p): p is FoodPortion => p !== null);
}

/** Ajoute des aliments à un repas (le crée s'il n'existe pas). Ne modifie pas `log`. */
export function appendToMeal(
  log: readonly MealLog[],
  mealName: string,
  portions: readonly FoodPortion[],
  meta: { id: string; at: string },
): MealLog[] {
  const items = portions.map(sanitizePortion).filter((p): p is FoodPortion => p !== null);
  const copy = log.map((m) => ({
    ...m,
    items: m.items.map((i) => ({ ...i, food: { ...i.food } })),
  }));
  if (items.length === 0) return copy;
  const existing = copy.find((m) => m.mealName === mealName);
  if (existing) {
    existing.items = [...existing.items, ...items];
    return copy;
  }
  return [...copy, { id: meta.id, mealName, items, loggedAt: meta.at }];
}

export interface CopyableMeal extends Macros {
  mealName: string;
  count: number;
  /** « Flocons d'avoine, Skyr nature… » */
  preview: string;
}

/** Repas non vides d'un jour, pour « Copier un repas d'un autre jour ». */
export function copyableMeals(log: readonly MealLog[]): CopyableMeal[] {
  const names = [...new Set(log.map((m) => m.mealName))];
  return names
    .map((mealName) => {
      const items = mealPortions(log, mealName);
      const shown = items.slice(0, 3).map((i) => i.food.name);
      return {
        mealName,
        count: items.length,
        preview: shown.join(', ') + (items.length > 3 ? '…' : ''),
        ...sumMacros(items),
      };
    })
    .filter((m) => m.count > 0);
}

/** Date locale « AAAA-MM-JJ » décalée de `days` jours. */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

// ─── Protéines réparties ────────────────────────────────────────────────────

export function normalizeNutritionPrefs(raw: unknown): NutritionPrefs {
  const d = DEFAULT_NUTRITION_PREFS;
  const x = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof NutritionPrefs, unknown>
  >;
  const meals = Math.round(num(x.mealsPerDay));
  const perMeal = num(x.proteinPerMealG);
  const minG = x.proteinReminderMinG;
  return {
    mealsPerDay: meals >= 1 && meals <= 8 ? meals : d.mealsPerDay,
    proteinPerMealG: perMeal >= 1 && perMeal <= 200 ? Math.round(perMeal) : null,
    proteinReminder: typeof x.proteinReminder === 'boolean' ? x.proteinReminder : d.proteinReminder,
    proteinReminderTime:
      typeof x.proteinReminderTime === 'string' && TIME_RE.test(x.proteinReminderTime)
        ? x.proteinReminderTime
        : d.proteinReminderTime,
    proteinReminderMinG:
      typeof minG === 'number' && Number.isFinite(minG) && minG >= 0 && minG <= 200
        ? Math.round(minG)
        : d.proteinReminderMinG,
  };
}

/** Objectif de protéines par repas (g) : réglage manuel, sinon objectif du jour ÷ repas. */
export function mealProteinTarget(dailyProteinG: number, prefs: NutritionPrefs): number {
  if (prefs.proteinPerMealG) return prefs.proteinPerMealG;
  const meals = Math.max(1, prefs.mealsPerDay);
  return dailyProteinG > 0 ? Math.round(dailyProteinG / meals) : 0;
}

export interface MealSection {
  mealName: string;
  items: Array<FoodPortion & { idx: number }>;
  kcal: number;
  proteinG: number;
  /** Objectif de protéines du repas (g), 0 sans plan. */
  targetG: number;
  /** 0 → 100. */
  pct: number;
  reached: boolean;
  /** « 24 / 40 g » */
  proteinLabel: string;
}

/**
 * Sections du journal : les repas habituels (toujours affichés, même vides),
 * puis les autres repas présents dans le journal.
 */
export function mealSections(
  log: readonly MealLog[],
  slots: readonly string[],
  targetG: number,
): MealSection[] {
  const names = [...slots, ...log.map((m) => m.mealName).filter((n) => !slots.includes(n))];
  return [...new Set(names)].map((mealName) => {
    const items = log
      .filter((m) => m.mealName === mealName)
      .flatMap((m) => m.items)
      .map((item, idx) => ({ ...item, idx }));
    const m = sumMacros(items);
    const pct =
      targetG > 0 ? Math.max(0, Math.min(100, Math.round((m.proteinG / targetG) * 100))) : 0;
    return {
      mealName,
      items,
      kcal: m.kcal,
      proteinG: m.proteinG,
      targetG,
      pct,
      reached: targetG > 0 && m.proteinG >= targetG,
      proteinLabel: `${Math.round(m.proteinG)} / ${Math.round(targetG)} g`,
    };
  });
}

/** Grammes de protéines manquants (arrondis), 0 si l'objectif est atteint. */
export function proteinShortfall(consumedG: number, targetG: number): number {
  return Math.max(0, Math.round(num(targetG) - num(consumedG)));
}

export function proteinReminderBody(missingG: number): string {
  return `Il te manque ${Math.round(missingG)} g de protéines aujourd'hui`;
}

export interface ProteinReminderPlan {
  at: Date;
  missingG: number;
  body: string;
}

/**
 * Rappel du soir : aujourd'hui à l'heure choisie, seulement si le rappel est actif,
 * que la journée a été suivie (au moins un aliment), que l'heure est à venir et qu'il
 * manque plus que le seuil. null sinon (objectif atteint : aucune notification).
 */
export function planProteinReminder(input: {
  now: Date;
  prefs: NutritionPrefs;
  consumedG: number;
  targetG: number;
  loggedToday: boolean;
}): ProteinReminderPlan | null {
  const { now, prefs } = input;
  if (!prefs.proteinReminder || !input.loggedToday || !(input.targetG > 0)) return null;
  const missingG = proteinShortfall(input.consumedG, input.targetG);
  if (missingG <= prefs.proteinReminderMinG || missingG <= 0) return null;
  const [h, m] = (
    TIME_RE.test(prefs.proteinReminderTime)
      ? prefs.proteinReminderTime
      : DEFAULT_NUTRITION_PREFS.proteinReminderTime
  )
    .split(':')
    .map(Number) as [number, number];
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= now.getTime()) return null;
  return { at, missingG, body: proteinReminderBody(missingG) };
}
