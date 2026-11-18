import { cameraScanSupported, scanBarcodeWithCamera } from '../lib/barcode-camera';
import Alpine from 'alpinejs';
import { MACRO_COLORS } from '../lib/palette';
import { mealTimingPlan, STORAGE_KEYS, type MealTiming, type NutritionPlan } from '@kinetic/core';

interface ScannedFoodEntry {
  name: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
}

interface NutritionStoreShape {
  plan: NutritionPlan | null;
  init(): Promise<void>;
  recalculatePlan(): Promise<void>;
  addMealItem(mealName: string, food: unknown, grams: number): Promise<boolean>;
  scanBarcode(barcode: string): Promise<ScannedFoodEntry | null>;
}

interface LocalFood {
  id: string;
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  category: string;
}

/** Barre de macro telle que la renvoie le store (`$store.nutrition.macroBars`). */
interface MacroBarLike {
  key: 'proteinG' | 'carbsG' | 'fatG';
  label: string;
  pct: number;
  over: boolean;
  detail: string;
  consumed: number;
}

/**
 * Couleurs des trois macros (lib/palette.ts, partagées avec le store) :
 * protéines violet, glucides turquoise, lipides ambre. Elles ne suivent pas le
 * thème d'accent, qui colore déjà l'anneau des calories.
 */
export { MACRO_COLORS };

export interface MacroView {
  key: MacroBarLike['key'];
  label: string;
  detail: string;
  over: boolean;
  pct: number;
  /** Style de la barre : largeur en % (lue par les tests e2e) + dégradé. */
  barStyle: string;
  /** Pastille de légende. */
  dotStyle: string;
}

/** 0 → 100, borné, arrondi. */
export function clampPct(value: number, target: number): number {
  if (!(target > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

/** Variable CSS d'un anneau `.k-ring-value` (`--p: 0…100`). */
export function ringVar(pct: number): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return `--p: ${p}`;
}

/** Barres de macros prêtes à afficher : couleur, largeur, pastille. */
export function macroViews(bars: readonly MacroBarLike[]): MacroView[] {
  return bars.map((b) => {
    const c = MACRO_COLORS[b.key];
    const pct = Math.max(0, Math.min(100, Math.round(b.pct || 0)));
    // Un minimum visible dès la première bouchée, sinon 0 %.
    const width = b.consumed > 0 && pct < 2 ? 2 : pct;
    return {
      key: b.key,
      label: b.label,
      detail: b.detail,
      over: b.over,
      pct,
      barStyle: `width: ${width}%; background-image: linear-gradient(90deg, ${c.from}, ${c.to}); box-shadow: 0 0 12px -2px ${c.glow}`,
      dotStyle: `background-color: ${c.from}`,
    };
  });
}

let _foodDb: LocalFood[] | null = null;

async function loadFoodDb(): Promise<LocalFood[]> {
  if (_foodDb) return _foodDb;
  try {
    const res = await fetch('/foods.fr.json');
    _foodDb = (await res.json()) as LocalFood[];
    return _foodDb;
  } catch {
    return [];
  }
}

export function nutrition() {
  return {
    showAddForm: false,
    trainingToday: new Date().getDay() !== 0 && new Date().getDay() !== 6,
    newMeal: { mealName: 'Matin', name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0 },

    // ── Recherche d'aliments ──────────────────────────────────────────────────
    foodQuery: '',
    foodResults: [] as LocalFood[],
    selectedFood: null as LocalFood | null,
    foodDbReady: false,

    // ── Scan code-barres (OpenFoodFacts) ──────────────────────────────────────
    barcode: '',
    cameraScan: cameraScanSupported(),
    scanning: false,

    /** Barres de macros colorées (protéines, glucides, lipides). */
    get macroViews(): MacroView[] {
      const store = Alpine.store('nutrition') as { macroBars?: MacroBarLike[] } | undefined;
      return macroViews(store?.macroBars ?? []);
    },

    /** Anneau des calories (extérieur). */
    get kcalRingStyle(): string {
      const store = Alpine.store('nutrition') as
        | { plan: NutritionPlan | null; consumed?: { kcal: number } }
        | undefined;
      return ringVar(clampPct(store?.consumed?.kcal ?? 0, store?.plan?.macros?.kcal ?? 0));
    },

    /** Anneaux intérieurs des macros, dans l'ordre protéines, glucides, lipides. */
    macroRingStyle(key: MacroBarLike['key']): string {
      const v = this.macroViews.find((m) => m.key === key);
      return ringVar(v ? v.pct : 0);
    },

    macroRingColor(key: MacroBarLike['key']): string {
      return `color: ${MACRO_COLORS[key].from}`;
    },

    get mealTimings(): MealTiming[] {
      const store = Alpine.store('nutrition') as NutritionStoreShape | undefined;
      const plan = store?.plan;
      if (!plan) return [];
      return mealTimingPlan(plan, this.trainingToday);
    },

    async init(): Promise<void> {
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      await store.init();
      await store.recalculatePlan();
      // Précharger la DB en arrière-plan pour une recherche instantanée
      void loadFoodDb().then(() => {
        this.foodDbReady = true;
      });
    },

    /** Recherche dans la base locale — max 8 résultats. */
    async searchFood(): Promise<void> {
      const q = this.foodQuery.trim().toLowerCase();
      if (q.length < 2) {
        this.foodResults = [];
        return;
      }
      const db = await loadFoodDb();
      this.foodResults = db.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
    },

    /** Sélectionne un aliment de la base et pré-remplit le formulaire. */
    selectFood(food: LocalFood): void {
      this.selectedFood = food;
      this.newMeal.name = food.name;
      this.newMeal.kcal = food.kcal;
      this.newMeal.protein = food.protein;
      this.newMeal.carbs = food.carbs;
      this.newMeal.fat = food.fat;
      this.foodQuery = food.name;
      this.foodResults = [];
    },

    /** Cherche un produit par code-barres (OpenFoodFacts) et pré-remplit le formulaire. */
    async scanWithCamera(): Promise<void> {
      if (this.scanning) return;
      const result = await scanBarcodeWithCamera();
      if (result.status === 'ok') {
        this.barcode = result.code;
        await this.scanProduct();
      } else if (result.status === 'unavailable') {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'info',
              message: 'Le scanner se prépare (première utilisation). Réessaie dans un instant.',
            },
          }),
        );
      }
    },

    async scanProduct(): Promise<void> {
      const code = this.barcode.trim();
      if (!code || this.scanning) return;
      this.scanning = true;
      try {
        const store = Alpine.store('nutrition') as NutritionStoreShape;
        const food = await store.scanBarcode(code);
        if (!food) return;
        this.selectedFood = null;
        this.newMeal.name = food.name;
        this.newMeal.kcal = food.kcalPer100;
        this.newMeal.protein = food.proteinPer100;
        this.newMeal.carbs = food.carbsPer100;
        this.newMeal.fat = food.fatPer100;
        this.foodQuery = food.name;
        this.foodResults = [];
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'success', message: `${food.name} trouvé — vérifie la quantité ✓` },
          }),
        );
      } finally {
        this.scanning = false;
      }
    },

    /** Vide la sélection pour permettre la saisie manuelle. */
    clearFoodSelection(): void {
      this.selectedFood = null;
      this.foodQuery = '';
      this.newMeal.name = '';
    },

    async logFood(): Promise<void> {
      const { name, grams, kcal, protein, carbs, fat, mealName } = this.newMeal;
      if (!name || grams <= 0) return;
      const macros = [kcal, protein, carbs, fat];
      if (macros.some((v) => !Number.isFinite(v) || v < 0)) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Valeurs invalides (doivent être ≥ 0).' },
          }),
        );
        return;
      }
      const food = {
        name,
        kcalPer100: kcal,
        proteinPer100: protein,
        carbsPer100: carbs,
        fatPer100: fat,
      };
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      const added = await store.addMealItem(mealName, food, grams);
      if (!added) return;

      // Reset
      this.newMeal = {
        mealName: 'Matin',
        name: '',
        grams: 100,
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      };
      this.foodQuery = '';
      this.selectedFood = null;
      this.foodResults = [];
      this.barcode = '';
      this.showAddForm = false;

      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'success', message: `${name} ajouté ✓` },
        }),
      );
    },
  };
}
