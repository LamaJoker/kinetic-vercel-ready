/**
 * RPE Chart Domain — table RPE/RIR → %1RM (autorégulation RTS).
 *
 * Le moteur de progression historique compare la RPE à une cible et ajuste d'un
 * incrément fixe. C'est aveugle à l'intensité réelle : un set à 8 reps @ RPE 7
 * et un autre à 8 reps @ RPE 9 ne représentent pas la même fraction du 1RM, donc
 * pas le même saut de charge. Cette table convertit (reps, RPE) en %1RM et permet
 * de calculer la charge *exacte* pour viser une RPE donnée.
 *
 * Méthode (Tuchscherer / Reactive Training Systems) :
 *   reps effectives = reps + RIR, avec RIR = 10 − RPE.
 *   On lit ensuite le %1RM correspondant à ce nombre de "reps à RPE 10" (vrai
 *   rep-max). Ex : 8 reps @ RPE 8 → RIR 2 → 10 reps effectives → ~73.9 % du 1RM.
 *
 * Sources :
 *   - Mike Tuchscherer — RTS Reactive Training Manual (RPE/RIR chart)
 *   - Helms, Morgan, Valdez — The Muscle & Strength Pyramid: Training (2019)
 *
 * Pur — aucune dépendance, aucun I/O.
 */

/** Set minimal pour la sélection du top-set — découplé de progression.domain. */
export interface RpeSet {
  reps: number;
  weightKg: number;
  rpe: number;
}

/**
 * %1RM par "reps à RPE 10" (vrai rep-max). Valeurs RTS standard.
 * 13–15 extrapolées linéairement (~ −2 %/rep) pour rester définies en haute rep.
 */
const RPE10_PERCENT: Readonly<Record<number, number>> = {
  1: 1.0,
  2: 0.955,
  3: 0.922,
  4: 0.892,
  5: 0.863,
  6: 0.837,
  7: 0.811,
  8: 0.786,
  9: 0.762,
  10: 0.739,
  11: 0.717,
  12: 0.694,
  13: 0.673,
  14: 0.653,
  15: 0.634,
};

const MIN_KEY = 1;
const MAX_KEY = 15;
/** Pente moyenne des deux derniers points — sert à extrapoler au-delà de 15. */
const TAIL_SLOPE = RPE10_PERCENT[MAX_KEY]! - RPE10_PERCENT[MAX_KEY - 1]!;
/** Plancher : on ne descend pas sous ~30 % du 1RM (zone endurance, hors charte). */
const MIN_PERCENT = 0.3;

/** RPE valides sur la charte : 6 à 10. */
function clampRpe(rpe: number): number {
  if (!Number.isFinite(rpe)) return 8;
  return Math.max(6, Math.min(10, rpe));
}

/** %1RM pour un nombre (éventuellement fractionnaire) de reps effectives. */
function percentForEffectiveReps(effectiveReps: number): number {
  if (effectiveReps <= MIN_KEY) return RPE10_PERCENT[MIN_KEY]!;
  if (effectiveReps >= MAX_KEY) {
    const extra = effectiveReps - MAX_KEY;
    return Math.max(MIN_PERCENT, RPE10_PERCENT[MAX_KEY]! + TAIL_SLOPE * extra);
  }
  const lo = Math.floor(effectiveReps);
  const hi = Math.ceil(effectiveReps);
  if (lo === hi) return RPE10_PERCENT[lo]!;
  const frac = effectiveReps - lo;
  return RPE10_PERCENT[lo]! + (RPE10_PERCENT[hi]! - RPE10_PERCENT[lo]!) * frac;
}

/**
 * percentOf1RM — fraction du 1RM que représente un set de `reps` à `rpe`.
 * RPE clampée à [6, 10] ; reps planchées à 1.
 */
export function percentOf1RM(reps: number, rpe: number): number {
  const r = Math.max(1, Math.floor(reps));
  const rir = 10 - clampRpe(rpe);
  return percentForEffectiveReps(r + rir);
}

/**
 * estimatedE1rmFromRpe — 1RM estimé en tenant compte de la réserve (RIR).
 * Plus juste qu'Epley qui suppose toujours l'échec (RPE 10).
 */
export function estimatedE1rmFromRpe(weightKg: number, reps: number, rpe: number): number {
  const w = Math.max(0, weightKg);
  if (w === 0) return 0;
  return w / percentOf1RM(reps, rpe);
}

/**
 * loadForReps — charge de travail pour atteindre `targetReps` à `targetRpe`,
 * à partir d'un 1RM estimé. Arrondie au pas si fourni.
 */
export function loadForReps(
  oneRmKg: number,
  targetReps: number,
  targetRpe: number,
  incrementKg?: number,
): number {
  const raw = Math.max(0, oneRmKg) * percentOf1RM(targetReps, targetRpe);
  if (incrementKg && incrementKg > 0) {
    return Math.max(0, Math.round(raw / incrementKg) * incrementKg);
  }
  return Math.max(0, raw);
}

/**
 * pickTopSet — meilleur set "de travail" d'un lot, mesuré par e1RM RPE-aware.
 * Sert à baser une suggestion sur le set le plus lourd d'une séance plutôt que
 * sur le dernier set loggé (souvent un back-off ou un échauffement).
 * Retourne `null` pour un lot vide.
 */
export function pickTopSet<T extends RpeSet>(sets: readonly T[]): T | null {
  let best: T | null = null;
  let bestE1rm = -Infinity;
  for (const s of sets) {
    const est = estimatedE1rmFromRpe(s.weightKg, s.reps, s.rpe);
    if (est > bestE1rm) {
      bestE1rm = est;
      best = s;
    }
  }
  return best;
}
