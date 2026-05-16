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
 *   - Israetel, Hoffmann, Case — Scientific Principles of Strength Training (2015)
 *
 * Pur — aucune dépendance, aucun I/O.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerformedSet {
  reps: number;
  weightKg: number;
  rpe: number; // 6-10
  at: string; // ISO datetime
}

export interface ProgressionInput {
  exerciseId: string;
  targetReps: number; // ex: 8
  targetRpe: number; // ex: 8
  incrementKg: number; // ex: 2.5 barbell, 2 dumbbell, 5 machine
  history: readonly PerformedSet[]; // la plus récente en dernier
}

export type ProgressionStrategy =
  | 'increase_weight' // +1 increment
  | 'increase_reps' // +1 rep (double progression)
  | 'hold' // même charge, consolider
  | 'deload' // -10% pour récupérer
  | 'first_time'; // pas d'historique

export interface ProgressionSuggestion {
  strategy: ProgressionStrategy;
  suggestedWeight: number;
  suggestedReps: number;
  suggestedRpe: number;
  confidence: number; // 0..1
  rationale: string; // explication courte
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
 *
 * Pourquoi bridé à 20 reps :
 *   La formule d'Epley devient imprécise au-delà de ~10 reps car elle suppose
 *   une relation linéaire force/fatigue qui n'est plus valide en haute répétition.
 *   Le bridage à 20 est conservateur — en pratique, on ne calcule l'e1RM que pour
 *   des séries de force (1–10 reps). Si jamais ce plafond est levé, la précision
 *   du moteur de suggestion se dégradera significativement.
 *   Source : Epley (1985), validé par Brzycki (1993) pour la plage 1–10 reps.
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
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - xMean) * (values[i]! - yMean);
    den += (xs[i]! - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─── Algorithme principal ────────────────────────────────────────────────────

/**
 * Fenêtre temporelle pour le deload (14 jours).
 *
 * Pourquoi 14 jours et non "3 dernières séances" :
 *   Le critère "3 séances à RPE >= 9.5" était insensible à la fréquence.
 *   Un athlète s'entraînant 3×/sem déclenchait le deload après 7 jours,
 *   un 2×/sem attendait 10+ jours. La fenêtre de 14j normalise ce biais.
 *   Source : Israetel — Block periodization recommends ~2-week assessment
 *   windows for fatigue monitoring.
 */
const DELOAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * suggestProgression — stratégie de progression basée sur RPE + trend e1RM.
 *
 * Règles (dans cet ordre) :
 *   1. Historique vide → 'first_time', charge "sécuritaire" (barre à vide si pas fourni).
 *   2. Dans la fenêtre de 14j : RPE moyen >= 9.5 ET e1RM stagnant → 'deload' (-10%).
 *   3. Dernier set à RPE <= targetRpe - 1 ET reps >= targetReps → 'increase_weight' (+incrément).
 *   4. Dernier set à RPE dans [target-0.5, target+0.5] ET reps < targetReps → 'increase_reps'.
 *   5. Sinon → 'hold' (même charge, garder la qualité).
 */
export function suggestProgression(input: ProgressionInput): ProgressionSuggestion {
  const { targetReps, targetRpe, incrementKg, history } = input;

  if (history.length === 0) {
    return {
      strategy: 'first_time',
      suggestedWeight: 0,
      suggestedReps: targetReps,
      suggestedRpe: targetRpe,
      confidence: 0.3,
      rationale:
        'Première séance sur cet exercice : choisis une charge qui te laisse 2-3 reps en réserve.',
    };
  }

  const last = history[history.length - 1]!;

  // 2. Deload : évaluation sur fenêtre temporelle de 14 jours
  //    (pas juste les 3 dernières séances — sensible à la fréquence d'entraînement)
  const windowStart = Date.now() - DELOAD_WINDOW_MS;
  const recentSets = history.filter((s) => Date.parse(s.at) >= windowStart);

  if (recentSets.length >= 3) {
    const avgRpeRecent = avg(recentSets.map((s) => s.rpe));
    const e1rmRecent = recentSets.map((s) => e1rm(s.weightKg, s.reps));
    const trendRecent = slope(e1rmRecent);

    if (avgRpeRecent >= 9.5 && trendRecent <= 0) {
      return {
        strategy: 'deload',
        suggestedWeight: roundTo(last.weightKg * 0.9, incrementKg),
        suggestedReps: targetReps,
        suggestedRpe: Math.max(6, targetRpe - 2),
        confidence: 0.8,
        rationale: `RPE moyen ${avgRpeRecent.toFixed(1)} sur ${recentSets.length} séances (14j) sans gain d'e1RM — semaine de deload (-10%) recommandée.`,
      };
    }
  }

  // 3. Charge trop facile ET objectif reps atteint
  if (last.rpe <= targetRpe - 1 && last.reps >= targetReps) {
    return {
      strategy: 'increase_weight',
      suggestedWeight: roundTo(last.weightKg + incrementKg, incrementKg),
      suggestedReps: targetReps,
      suggestedRpe: targetRpe,
      confidence: 0.9,
      rationale: `RPE ${last.rpe} < cible ${targetRpe} avec reps ok — +${incrementKg} kg.`,
    };
  }

  // 4. Charge OK, mais pas encore les reps
  if (Math.abs(last.rpe - targetRpe) <= 0.5 && last.reps < targetReps) {
    return {
      strategy: 'increase_reps',
      suggestedWeight: last.weightKg,
      suggestedReps: Math.min(targetReps, last.reps + 1),
      suggestedRpe: targetRpe,
      confidence: 0.75,
      rationale: 'Même charge, vise +1 rep (double progression).',
    };
  }

  // 5. Trop dur mais pas deload
  if (last.rpe > targetRpe + 0.5) {
    return {
      strategy: 'hold',
      suggestedWeight: last.weightKg,
      suggestedReps: targetReps,
      suggestedRpe: targetRpe,
      confidence: 0.6,
      rationale: `RPE ${last.rpe} > cible ${targetRpe} — consolider avant d'augmenter.`,
    };
  }

  return {
    strategy: 'hold',
    suggestedWeight: last.weightKg,
    suggestedReps: targetReps,
    suggestedRpe: targetRpe,
    confidence: 0.5,
    rationale: 'Maintiens la charge actuelle pour stabiliser la technique.',
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
  const trend = slope(last5.map((s) => e1rm(s.weightKg, s.reps)));
  return avgRpe >= 9 && trend <= 0;
}
