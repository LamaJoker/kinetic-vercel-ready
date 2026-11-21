/**
 * Outils de calcul (page Outils) : 1RM estimé selon plusieurs formules, table de
 * pourcentages arrondie aux disques réellement disponibles, charge pour X reps
 * à une RPE donnée (charte RTS de rpe-chart.domain).
 *
 * Formules (charge w, répétitions r, à l'échec) :
 *   - Epley (1985)    : w × (1 + r / 30)
 *   - Brzycki (1993)  : w × 36 / (37 − r)
 *   - Lombardi (1989) : w × r^0,10
 * Toutes valent w pour r = 1. Au-delà de 10 reps, l'estimation devient peu fiable.
 *
 * Pur — aucune dépendance d'E/S.
 */
import {
  calculatePlates,
  formatPlateLoad,
  DEFAULT_PLATES_METRIC,
} from './plate-calculator.domain.js';
import { percentOf1RM } from './rpe-chart.domain.js';
import { e1rm } from './progression.domain.js';

/** Au-delà, les formules divergent trop pour être utiles (bornes de saisie). */
export const ONE_RM_MAX_REPS = 20;
/** Fiabilité raisonnable jusqu'à 10 reps. */
export const ONE_RM_RELIABLE_REPS = 10;

export interface OneRmEstimate {
  epley: number;
  brzycki: number;
  lombardi: number;
  /** Moyenne des trois formules. */
  average: number;
  /** Faux au-delà de 10 reps : afficher un avertissement. */
  reliable: boolean;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 1RM estimé (kg, arrondi à 0,1) ; null si la saisie est inexploitable. */
export function estimateOneRm(weightKg: number, reps: number): OneRmEstimate | null {
  const w = Number(weightKg);
  const r = Math.floor(Number(reps));
  if (!(w > 0) || !(r >= 1) || r > ONE_RM_MAX_REPS) return null;
  const epley = r === 1 ? w : w * (1 + r / 30);
  const brzycki = (w * 36) / (37 - r);
  const lombardi = w * Math.pow(r, 0.1);
  return {
    epley: r1(epley),
    brzycki: r1(brzycki),
    lombardi: r1(lombardi),
    average: r1((epley + brzycki + lombardi) / 3),
    reliable: r <= ONE_RM_RELIABLE_REPS,
  };
}

export interface BarSetup {
  barKg: number;
  /** Disques disponibles (kg) ; vide → jeu standard. */
  plates?: readonly number[];
  /** Haltères, machines… : arrondi à ce pas, sans barre ni disques (perSide vide). */
  incrementKg?: number;
}

export interface RoundedLoad {
  /** Charge réellement chargeable (barre + disques). */
  kg: number;
  /** Disques par côté, ex. « 20×1, 2.5×1 » ou « barre seule ». */
  perSide: string;
}

/**
 * Charge chargeable la plus proche de `targetKg` avec la barre et les disques
 * donnés (pas = 2 × plus petit disque). Jamais sous le poids de la barre.
 */
export function roundToPlates(targetKg: number, setup: BarSetup): RoundedLoad {
  if (setup.incrementKg && setup.incrementKg > 0) {
    const inc = setup.incrementKg;
    return {
      kg: Math.max(0, Math.round(Math.round((Number(targetKg) || 0) / inc) * inc * 100) / 100),
      perSide: '',
    };
  }
  const bar = Math.max(0, Number(setup.barKg) || 0);
  const plates = setup.plates?.length ? setup.plates : DEFAULT_PLATES_METRIC;
  const smallest = Math.min(...plates.filter((p) => p > 0));
  const step = Number.isFinite(smallest) ? smallest * 2 : 1;
  const net = Math.max(0, (Number(targetKg) || 0) - bar);
  const wanted = bar + Math.round(net / step) * step;
  const calc = calculatePlates({ targetKg: wanted, barKg: bar, availablePlates: plates });
  return { kg: calc.achievedKg, perSide: formatPlateLoad(calc.perSide) };
}

export interface PercentRow {
  pct: number;
  /** Charge exacte (kg, 0,1). */
  exactKg: number;
  load: RoundedLoad;
}

/** Table de pourcentages d'un max : 100 % → 50 % par pas de 5, arrondie aux disques. */
export function percentTable(maxKg: number, setup: BarSetup, from = 50, step = 5): PercentRow[] {
  const max = Number(maxKg);
  if (!(max > 0)) return [];
  const rows: PercentRow[] = [];
  for (let pct = 100; pct >= from; pct -= step) {
    const exact = (max * pct) / 100;
    rows.push({ pct, exactKg: r1(exact), load: roundToPlates(exact, setup) });
  }
  return rows;
}

/** RPE de la table (10 → 6 par demi-points). */
export const RPE_TABLE_RPES: readonly number[] = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6];
/** Répétitions de la table (1 → 12). */
export const RPE_TABLE_REPS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** % du 1RM (entier arrondi à 0,1) pour `reps` à `rpe` — charte RTS (Tuchscherer / Helms). */
export function rpePercent(reps: number, rpe: number): number {
  return r1(percentOf1RM(reps, rpe) * 100);
}

/** Lignes de la table RPE : une par nombre de reps, une colonne par RPE. */
export function rpeTable(): Array<{ reps: number; pcts: number[] }> {
  return RPE_TABLE_REPS.map((reps) => ({
    reps,
    pcts: RPE_TABLE_RPES.map((rpe) => rpePercent(reps, rpe)),
  }));
}

export interface RpeLoad {
  pct: number;
  exactKg: number;
  load: RoundedLoad;
}

/** Charge pour `reps` répétitions à `rpe`, à partir d'un 1RM ; null sans 1RM. */
export function loadForRpe(
  oneRmKg: number,
  reps: number,
  rpe: number,
  setup: BarSetup,
): RpeLoad | null {
  const max = Number(oneRmKg);
  if (!(max > 0) || !(reps >= 1)) return null;
  const pct = percentOf1RM(reps, rpe);
  const exact = max * pct;
  return { pct: r1(pct * 100), exactKg: r1(exact), load: roundToPlates(exact, setup) };
}

export interface E1rmSet {
  exerciseId: string;
  weightKg: number;
  reps: number;
  performedAt: string;
}

/**
 * e1RM « connu » par exercice (Epley, comme le reste de l'app) : meilleur des
 * `windowDays` derniers jours, sinon meilleur de tout l'historique.
 */
export function knownE1rmByExercise(
  sets: readonly E1rmSet[],
  now: Date,
  windowDays = 84,
): Map<string, number> {
  const since = now.getTime() - windowDays * 86_400_000;
  const recent = new Map<string, number>();
  const all = new Map<string, number>();
  for (const s of sets) {
    if (!(s.reps >= 1) || !(s.weightKg > 0)) continue;
    const est = e1rm(s.weightKg, s.reps);
    if (est > (all.get(s.exerciseId) ?? 0)) all.set(s.exerciseId, est);
    if (Date.parse(s.performedAt) >= since && est > (recent.get(s.exerciseId) ?? 0))
      recent.set(s.exerciseId, est);
  }
  const out = new Map<string, number>();
  for (const [id, best] of all) out.set(id, r1(recent.get(id) ?? best));
  return out;
}
