/**
 * Store Alpine `nutrition` — journal macros du jour + plan cible
 * FIX: FoodEntry défini localement (pas exporté par @kinetic/core)
 */
import { buildNutritionPlan, macroProgress, STORAGE_KEYS } from '@kinetic/core';
import type { NutritionPlan } from '@kinetic/core';
import { getDeps } from '../deps';

// FIX: défini ici au lieu d'être importé depuis @kinetic/core
export interface FoodEntry {
  name:           string;
  kcalPer100:     number;
  proteinPer100:  number;
  carbsPer100:    number;
  fatPer100:      number;
}

export interface LoggedMeal {
  id:       string;
  mealName: string;
  items:    Array<{ food: FoodEntry; grams: number }>;
  loggedAt: string;
}

const KEY_PLAN = STORAGE_KEYS.NUTRITION_PLAN;
const KEY_LOG  = (date: string) => STORAGE_KEYS.NUTRITION_LOG(date);

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export function nutritionStore() {
  return {
    plan:        null as NutritionPlan | null,
    todayLog:    [] as LoggedMeal[],
    loading:     true,
    _addMealInflightNames: new Set<string>(),

    get consumed() {
      let kcal = 0, proteinG = 0, carbsG = 0, fatG = 0;
      for (const meal of this.todayLog) {
        for (const item of meal.items) {
          const f = item.grams / 100;
          kcal     += item.food.kcalPer100    * f;
          proteinG += item.food.proteinPer100 * f;
          carbsG   += item.food.carbsPer100   * f;
          fatG     += item.food.fatPer100     * f;
        }
      }
      return {
        kcal: Math.round(kcal),
        proteinG: +proteinG.toFixed(1),
        carbsG:   +carbsG.toFixed(1),
        fatG:     +fatG.toFixed(1),
      };
    },

    get progress() {
      if (!this.plan) return null;
      return macroProgress(this.consumed, this.plan.macros);
    },

    get remaining() {
      if (!this.plan) return null;
      const c = this.consumed;
      const t = this.plan.macros;
      return {
        kcal:     Math.max(0, t.kcal     - c.kcal),
        proteinG: Math.max(0, +(t.proteinG - c.proteinG).toFixed(1)),
        carbsG:   Math.max(0, +(t.carbsG   - c.carbsG).toFixed(1)),
        fatG:     Math.max(0, +(t.fatG     - c.fatG).toFixed(1)),
      };
    },

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const stored = await deps.storage.get<NutritionPlan>(KEY_PLAN);
        this.plan = stored;
        const log = await deps.storage.get<LoggedMeal[]>(KEY_LOG(todayIso()));
        this.todayLog = log ?? [];
      } catch (err) {
        console.error('[nutrition] init failed:', err);
      } finally {
        this.loading = false;
      }
    },

    async recalculatePlan(): Promise<void> {
      try {
        const deps = await getDeps();
        const profile = await deps.storage.get<Record<string, unknown>>(STORAGE_KEYS.USER_PROFILE);
        if (!profile) return;
        const plan = buildNutritionPlan(profile as unknown as Parameters<typeof buildNutritionPlan>[0]);
        this.plan = plan;
        await deps.storage.set(KEY_PLAN, plan);
      } catch (err) {
        console.error('[nutrition] recalculate failed:', err);
      }
    },

    async addMealItem(mealName: string, food: FoodEntry, grams: number): Promise<void> {
      if (this._addMealInflightNames.has(mealName)) return;
      this._addMealInflightNames.add(mealName);
      try {
        const deps  = await getDeps();
        const today = todayIso();
        // Mutation via spread, sans push() sur le proxy Alpine — évite que
        // IDB voie un Proxy non-clonable (DataCloneError sur Safari/Firefox).
        const existing = this.todayLog.find((m) => m.mealName === mealName);
        if (existing) {
          this.todayLog = this.todayLog.map((m) =>
            m.mealName !== mealName ? m :
            { ...m, items: [...m.items, { food, grams }] },
          );
        } else {
          this.todayLog = [...this.todayLog, {
            id: crypto.randomUUID(), mealName,
            items: [{ food, grams }], loggedAt: new Date().toISOString(),
          }];
        }
        await deps.storage.set(KEY_LOG(today), this.todayLog);
      } catch (err) {
        console.error('[nutrition] addMealItem failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Impossible d\'ajouter cet aliment. Réessaie.' },
        }));
      } finally {
        this._addMealInflightNames.delete(mealName);
      }
    },

    async removeMealItem(mealName: string, idx: number): Promise<void> {
      try {
        const deps  = await getDeps();
        const today = todayIso();
        this.todayLog = this.todayLog.map((m) =>
          m.mealName !== mealName ? m :
          { ...m, items: m.items.filter((_, i) => i !== idx) },
        );
        await deps.storage.set(KEY_LOG(today), this.todayLog);
      } catch (err) {
        console.error('[nutrition] removeMealItem failed:', err);
        window.dispatchEvent(new CustomEvent('kinetic:notify', {
          detail: { kind: 'error', message: 'Impossible de retirer cet aliment. Réessaie.' },
        }));
      }
    },
  };
}
