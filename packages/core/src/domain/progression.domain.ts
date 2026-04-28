/**
 * Progression Domain — moteur de suggestion intelligente pour la musculation.
 *
 * Objectif : recommander un poids / nombre de reps pour la prochaine séance
 * à partir de l'historique RPE et e1RM (Epley), sans appeler d'IA externe.
 *
 * Sources :
 *   - Mike Tuchscherer (RPE-based autoregulation)
 *   - Helms, Morgan, Valdez — Muscle & Strength Pyramid (2019)
 *   - Schoenfeld — Science & Development of Muscle Hypertrophy (2020)
 *
 * Pur — aucune dépendance, aucun I/O.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerformedSet {
  reps:     number;
  weightKg: number;
  rpe:      number;           // 6-10
  at:       string;           // ISO datetime
}

export interface ProgressionInput {
  exerciseId:   string;
  targetReps:   number;        // ex: 8
  targetRpe:    number;        // ex: 8
  incrementKg:  number;        // ex: 2.5 barbell, 2 dumbbell, 5 machine
  history:      readonly PerformedSet[]; // la plus récente en dernier
}

export type ProgressionStrategy =
  | 'increase_weight'      // +1 increment
  | 'increase_reps'        // +1 rep (double progression)
  | 'hold'                 // même charge, consolider
  | 'deload'               // -10% pour récupérer
  | 'first_time';          // pas d'historique

export interface ProgressionSuggestion {
  strategy:        ProgressionStrategy;
  suggestedWeight: number;
  suggestedReps:   number;
  suggestedRpe:    number;
  confidence:      number;     // 0..1
  rationale:       string;     // explication courte
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function roundTo(n: number, step: number): number {
  const s = step > 0 ? step : 2.5;
  return Math.round(n / s) * s;
}

function avg(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * e1RM — Epley (standard, bonne corrélation <= 10 reps).
 */
export function e1rm(weightKg: number, reps: number): number {
  const r = Math.max(1, Math.min(20, Math.floor(reps)));
  return weightKg * (1 + r / 30);
}

/**
 * Trend linéaire sur les N dernières entrées (régression simple).
 * > 0 => progression, < 0 => stagnation/régression.
 */
export function slope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const xMean = avg(xs);
  const yMean = avg(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - xMean) * (values[i]! - yMean);
    den += (xs[i]! - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─── Algorithme principal ────────────────────────────────────────────────────

/**
 * suggestProgression — stratégie de progression basée sur RPE + trend e1RM.
 *
 * Règles (dans cet ordre) :
 *   1. Historique vide → 'first_time', charge "sécuritaire" (barre à vide si pas fourni).
 *   2. 3 dernières séances à RPE >= 9.5 ET e1RM stagnant → 'deload' (-10%).
 *   3. Dernier set à RPE <= targetRpe - 1 ET reps >= targetReps → 'increase_weight' (+incrémen).
 *   4. Dernier set à RPE dans [target-0.5, target+0.5] ET reps < targetReps → 'increase_reps'.
 *   5. Sinon → 'hold' (même charge, garder la qualité).
 */
export function suggestProgression(input: ProgressionInput): ProgressionSuggestion {
  const { targetReps, targetRpe, incrementKg, history } = input;

  if (history.length === 0) {
    return {
      strategy:        'first_time',
      suggestedWeight: 0,
      suggestedReps:   targetReps,
      suggestedRpe:    targetRpe,
      confidence:      0.3,
      rationale:       'Première séance sur cet exercice : choisis une charge qui te laisse 2-3 reps en réserve.',
    };
  }

  const last = history[history.length - 1]!;
  const last3 = history.slice(-3);
  const e1rmSeries = history.slice(-6).map((s) => e1rm(s.weightKg, s.reps));
  const trend = slope(e1rmSeries);
  const avgRpe3 = avg(last3.map((s) => s.rpe));

  // 2. Deload : 3 dernières séances brûlées + e1RM plat/descendant
  if (last3.length >= 3 && avgRpe3 >= 9.5 && trend <= 0) {
    return {
      strategy:        'deload',
      suggestedWeight: roundTo(last.weightKg * 0.9, incrementKg),
      suggestedReps:   targetReps,
      suggestedRpe:    Math.max(6, targetRpe - 2),
      confidence:      0.8,
      rationale:       'RPE très élevé sur 3 séances sans gain d’e1RM — semaine de deload (-10%) recommandée.',
    };
  }

  // 3. Charge trop facile ET objectif reps atteint
  if (last.rpe <= targetRpe - 1 && last.reps >= targetReps) {
    return {
      strategy:        'increase_weight',
      suggestedWeight: roundTo(last.weightKg + incrementKg, incrementKg),
      suggestedReps:   targetReps,
      suggestedRpe:    targetRpe,
      confidence:      0.9,
      rationale:       `RPE ${last.rpe} < cible ${targetRpe} avec reps ok — +${incrementKg} kg.`,
    };
  }

  // 4. Charge OK, mais pas encore les reps
  if (Math.abs(last.rpe - targetRpe) <= 0.5 && last.reps < targetReps) {
    return {
      strategy:        'increase_reps',
      suggestedWeight: last.weightKg,
      suggestedReps:   Math.min(targetReps, last.reps + 1),
      suggestedRpe:    targetRpe,
      confidence:      0.75,
      rationale:       'Même charge, vise +1 rep (double progression).',
    };
  }

  // 5. Trop dur mais pas deload
  if (last.rpe > targetRpe + 0.5) {
    return {
      strategy:        'hold',
      suggestedWeight: last.weightKg,
      suggestedReps:   targetReps,
      suggestedRpe:    targetRpe,
      confidence:      0.6,
      rationale:       `RPE ${last.rpe} > cible ${targetRpe} — consolider avant d’augmenter.`,
    };
  }

  return {
    strategy:        'hold',
    suggestedWeight: last.weightKg,
    suggestedReps:   targetReps,
    suggestedRpe:    targetRpe,
    confidence:      0.5,
    rationale:       'Maintiens la charge actuelle pour stabiliser la technique.',
  };
}

/**
 * needsDeload — détection rapide, utile pour un indicateur "vous êtes cramé".
 * Critère : RPE moyen >= 9 sur les 5 dernières séances + pente d'e1RM <= 0.
 */
export function needsDeload(history: readonly PerformedSet[]): boolean {
  if (history.length < 5) return false;
  const last5 = history.slice(-5);
  const avgRpe = avg(last5.map((s) => s.rpe));
  const trend  = slope(last5.map((s) => e1rm(s.weightKg, s.reps)));
  return avgRpe >= 9 && trend <= 0;
}
