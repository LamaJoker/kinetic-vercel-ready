/**
 * Store Alpine `nutrition` — journal macros du jour + plan cible
 * FIX: FoodEntry défini localement (pas exporté par @kinetic/core)
 */
import { buildNutritionPlan, macroProgress, STORAGE_KEYS } from '@kinetic/core';
import type { NutritionPlan } from '@kinetic/core';
import { getDeps } from '../deps';
import { fetchFoodByBarcode, normalizeBarcode } from '../lib/openfoodfacts';

// FIX: défini ici au lieu d'être importé depuis @kinetic/core
export interface FoodEntry {
  name: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
}

export interface LoggedMeal {
  id: string;
  mealName: string;
  items: Array<{ food: FoodEntry; grams: number }>;
  loggedAt: string;
}

export interface MacroBar {
  key: 'proteinG' | 'carbsG' | 'fatG';
  label: string;
  consumed: number;
  target: number;
  /** 0 → 100, pour la largeur de la barre */
  pct: number;
  over: boolean;
  /** « 48 / 170 g » ou « Dépassé de 12 g » */
  detail: string;
  style: { width: string; backgroundColor: string };
}

const MACRO_DEFS: Array<{ key: MacroBar['key']; label: string; color: string }> = [
  { key: 'proteinG', label: 'Protéines', color: '#D93A34' },
  { key: 'carbsG', label: 'Glucides', color: '#F2C230' },
  { key: 'fatG', label: 'Lipides', color: '#8B9099' },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString('fr-FR');
}

export function buildMacroBars(
  consumed: { proteinG: number; carbsG: number; fatG: number },
  targets: { proteinG: number; carbsG: number; fatG: number } | null,
): MacroBar[] {
  return MACRO_DEFS.map(({ key, label, color }) => {
    const value = Math.max(0, consumed[key] || 0);
    const target = Math.max(0, targets?.[key] ?? 0);
    const ratio = target > 0 ? value / target : 0;
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const over = target > 0 && value > target * 1.05;
    return {
      key,
      label,
      consumed: value,
      target,
      pct,
      over,
      detail: over ? `Dépassé de ${fmt(value - target)} g` : `${fmt(value)} / ${fmt(target)} g`,
      // Un minimum visible dès la première bouchée, sinon 0 %.
      style: { width: `${value > 0 && pct < 2 ? 2 : pct}%`, backgroundColor: color },
    };
  });
}

export function ringDash(value: number, target: number, circumference: number): string {
  const ratio = target > 0 ? Math.max(0, Math.min(1, value / target)) : 0;
  return `${(ratio * circumference).toFixed(1)} ${circumference}`;
}

const KEY_PLAN = STORAGE_KEYS.NUTRITION_PLAN;
const KEY_LOG = (date: string) => STORAGE_KEYS.NUTRITION_LOG(date);

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nutritionStore() {
  return {
    plan: null as NutritionPlan | null,
    todayLog: [] as LoggedMeal[],
    loading: true,
    _pendingMealNames: [] as string[],

    get consumed() {
      let kcal = 0,
        proteinG = 0,
        carbsG = 0,
        fatG = 0;
      for (const meal of this.todayLog) {
        for (const item of meal.items) {
          const f = item.grams / 100;
          kcal += item.food.kcalPer100 * f;
          proteinG += item.food.proteinPer100 * f;
          carbsG += item.food.carbsPer100 * f;
          fatG += item.food.fatPer100 * f;
        }
      }
      return {
        kcal: Math.round(kcal),
        proteinG: +proteinG.toFixed(1),
        carbsG: +carbsG.toFixed(1),
        fatG: +fatG.toFixed(1),
      };
    },

    get progress() {
      if (!this.plan?.macros) return null;
      return macroProgress(this.consumed, this.plan.macros);
    },

    /**
     * Barres de macros prêtes à afficher (aucun calcul dans le template :
     * le build CSP d'Alpine n'autorise pas `Math` dans les expressions, ce qui
     * laissait les barres vides).
     */
    get macroBars(): MacroBar[] {
      return buildMacroBars(this.consumed, this.plan?.macros ?? null);
    },

    /** Anneau des calories : `stroke-dasharray` de l'arc rempli (circonférence 188). */
    get kcalDash(): string {
      const target = this.plan?.macros?.kcal ?? 0;
      return ringDash(this.consumed.kcal, target, 188);
    },

    get remaining() {
      if (!this.plan) return null;
      const c = this.consumed;
      const t = this.plan.macros;
      return {
        kcal: Math.max(0, t.kcal - c.kcal),
        proteinG: Math.max(0, +(t.proteinG - c.proteinG).toFixed(1)),
        carbsG: Math.max(0, +(t.carbsG - c.carbsG).toFixed(1)),
        fatG: Math.max(0, +(t.fatG - c.fatG).toFixed(1)),
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
        const plan = buildNutritionPlan(
          profile as unknown as Parameters<typeof buildNutritionPlan>[0],
        );
        this.plan = plan;
        await deps.storage.set(KEY_PLAN, plan);
      } catch (err) {
        console.error('[nutrition] recalculate failed:', err);
      }
    },

    async addMealItem(mealName: string, food: FoodEntry, grams: number): Promise<boolean> {
      if (!Number.isFinite(grams) || grams <= 0) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Quantité invalide (doit être > 0 g).' },
          }),
        );
        return false;
      }
      if (this._pendingMealNames.includes(mealName)) return false;
      this._pendingMealNames = [...this._pendingMealNames, mealName];
      try {
        const deps = await getDeps();
        const today = todayIso();
        // Lit depuis IDB plutôt que depuis this.todayLog (proxy Alpine) pour
        // éviter le DataCloneError : après le 1er ajout, Alpine réactivifie
        // todayLog et ses sous-objets deviennent des Proxy non-clonables par
        // l'algorithme structured-clone d'IDB. Les données IDB sont toujours
        // des objets JS bruts, sans Proxy.
        const rawLog = (await deps.storage.get<LoggedMeal[]>(KEY_LOG(today))) ?? [];
        const existing = rawLog.find((m) => m.mealName === mealName);
        const nextLog = existing
          ? rawLog.map((m) =>
              m.mealName !== mealName ? m : { ...m, items: [...m.items, { food, grams }] },
            )
          : [
              ...rawLog,
              {
                id: crypto.randomUUID(),
                mealName,
                items: [{ food, grams }],
                loggedAt: new Date().toISOString(),
              },
            ];
        await deps.storage.set(KEY_LOG(today), nextLog);
        // Mutate in-memory only after storage succeeds to keep state consistent
        this.todayLog = nextLog;
        return true;
      } catch (err) {
        console.error('[nutrition] addMealItem failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: "Impossible d'ajouter cet aliment. Réessaie." },
          }),
        );
        return false;
      } finally {
        this._pendingMealNames = this._pendingMealNames.filter((n) => n !== mealName);
      }
    },

    async removeMealItem(mealName: string, idx: number): Promise<void> {
      try {
        const deps = await getDeps();
        const today = todayIso();
        const rawLog = (await deps.storage.get<LoggedMeal[]>(KEY_LOG(today))) ?? [];
        const nextLog = rawLog.map((m) =>
          m.mealName !== mealName ? m : { ...m, items: m.items.filter((_, i) => i !== idx) },
        );
        await deps.storage.set(KEY_LOG(today), nextLog);
        // Mutate in-memory only after storage succeeds
        this.todayLog = nextLog;
      } catch (err) {
        console.error('[nutrition] removeMealItem failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Impossible de retirer cet aliment. Réessaie.' },
          }),
        );
      }
    },

    /**
     * scanBarcode — cherche un produit par code-barres via OpenFoodFacts et
     * renvoie un FoodEntry prêt à pré-remplir le formulaire (macros /100 g).
     * Renvoie null (+ notification) si code invalide, produit introuvable ou erreur.
     */
    async scanBarcode(barcode: string): Promise<FoodEntry | null> {
      const code = normalizeBarcode(barcode);
      if (code.length < 8) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Code-barres invalide (8 chiffres minimum).' },
          }),
        );
        return null;
      }
      const scanned = await fetchFoodByBarcode(code);
      if (!scanned) {
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'warning', message: 'Produit introuvable dans OpenFoodFacts.' },
          }),
        );
        return null;
      }
      return {
        name: scanned.brand ? `${scanned.name} (${scanned.brand})` : scanned.name,
        kcalPer100: scanned.kcalPer100,
        proteinPer100: scanned.proteinPer100,
        carbsPer100: scanned.carbsPer100,
        fatPer100: scanned.fatPer100,
      };
    },
  };
}
