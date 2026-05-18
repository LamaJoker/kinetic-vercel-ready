import Alpine from 'alpinejs';
import { mealTimingPlan, STORAGE_KEYS, type MealTiming, type NutritionPlan } from '@kinetic/core';

interface NutritionStoreShape {
  plan: NutritionPlan | null;
  init(): Promise<void>;
  recalculatePlan(): Promise<void>;
  addMealItem(mealName: string, food: unknown, grams: number): Promise<void>;
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
      await store.addMealItem(mealName, food, grams);

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
      this.showAddForm = false;

      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'success', message: `${name} ajouté ✓` },
        }),
      );
    },
  };
}
