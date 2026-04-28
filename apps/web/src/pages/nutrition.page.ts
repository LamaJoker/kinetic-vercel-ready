import Alpine from 'alpinejs';
import { mealTimingPlan, type MealTiming, type NutritionPlan } from '@kinetic/core';

interface NutritionStoreShape {
  plan: NutritionPlan | null;
  init(): Promise<void>;
  recalculatePlan(): Promise<void>;
  addMealItem(mealName: string, food: unknown, grams: number): Promise<void>;
}

export function nutrition() {
  return {
    showAddForm:   false,
    trainingToday: new Date().getDay() !== 0 && new Date().getDay() !== 6,
    newMeal: { mealName: 'Matin', name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0 },

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
    },

    async logFood(): Promise<void> {
      const { name, grams, kcal, protein, carbs, fat, mealName } = this.newMeal;
      if (!name || grams <= 0) return;
      const food = {
        name,
        kcalPer100:    kcal,
        proteinPer100: protein,
        carbsPer100:   carbs,
        fatPer100:     fat,
      };
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      await store.addMealItem(mealName, food, grams);
      this.newMeal = { mealName: 'Matin', name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0 };
      this.showAddForm = false;
      window.dispatchEvent(new CustomEvent('kinetic:notify', {
        detail: { kind: 'success', message: `${name} ajouté ✓` },
      }));
    },
  };
}
