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

import { estimatedE1rmFromRpe, loadForReps, pickTopSet } from './rpe-chart.domain.js';

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
 * referenceSet — set de référence pour la suggestion.
 *
 * Le dernier set loggé est souvent un back-off ou un échauffement et sous-estime
 * la vraie capacité du jour. On prend plutôt le *meilleur* set (e1RM RPE-aware)
 * de la séance la plus récente, les sets étant groupés par jour calendaire (UTC).
 * Pour un historique à un set par séance, c'est exactement le dernier set.
 */
function referenceSet(history: readonly PerformedSet[]): PerformedSet {
  const last = history[history.length - 1]!;
  const lastDay = last.at.slice(0, 10); // YYYY-MM-DD
  const sameSession = history.filter((s) => s.at.slice(0, 10) === lastDay);
  return (pickTopSet(sameSession) as PerformedSet | null) ?? last;
}

/**
 * suggestProgression — stratégie de progression basée sur RPE + trend e1RM.
 *
 * Règles (dans cet ordre) :
 *   1. Historique vide → 'first_time', charge "sécuritaire" (barre à vide si pas fourni).
 *   2. Dans la fenêtre de 14j : RPE moyen >= 9.5 ET e1RM stagnant → 'deload' (-10%).
 *   3. Set de réf. à RPE <= targetRpe - 1 ET reps >= targetReps → 'increase_weight'
 *      (charge cible RPE-aware via la charte RTS, plancher = +incrément).
 *   4. Set de réf. à RPE dans [target-0.5, target+0.5] ET reps < targetReps → 'increase_reps'.
 *   5. Sinon → 'hold' (même charge, garder la qualité).
 *
 * Le "set de référence" est le meilleur set de la séance la plus récente (cf.
 * referenceSet), pas le dernier set loggé.
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

  // Set de référence : meilleur set de la séance la plus récente (et non le
  // dernier set loggé, souvent un back-off). Voir referenceSet().
  const reference = referenceSet(history);

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
        suggestedWeight: roundTo(reference.weightKg * 0.9, incrementKg),
        suggestedReps: targetReps,
        suggestedRpe: Math.max(6, targetRpe - 2),
        confidence: 0.8,
        rationale: `RPE moyen ${avgRpeRecent.toFixed(1)} sur ${recentSets.length} séances (14j) sans gain d'e1RM — semaine de deload (-10%) recommandée.`,
      };
    }
  }

  // 3. Charge trop facile ET objectif reps atteint → charge cible RPE-aware.
  //    Au lieu d'un +incrément aveugle, on calcule la charge qui vise exactement
  //    targetRpe à targetReps, à partir du 1RM estimé (réserve RIR prise en compte).
  //    Plancher : jamais en-dessous d'un incrément au-dessus du set de référence,
  //    pour garder la sémantique "augmenter".
  if (reference.rpe <= targetRpe - 1 && reference.reps >= targetReps) {
    const e1 = estimatedE1rmFromRpe(reference.weightKg, reference.reps, reference.rpe);
    const rpeAware = loadForReps(e1, targetReps, targetRpe, incrementKg || 2.5);
    const floor = roundTo(reference.weightKg + incrementKg, incrementKg);
    const suggestedWeight = Math.max(rpeAware, floor);
    return {
      strategy: 'increase_weight',
      suggestedWeight,
      suggestedReps: targetReps,
      suggestedRpe: targetRpe,
      confidence: 0.9,
      rationale: `RPE ${reference.rpe} < cible ${targetRpe} avec reps ok — charge cible ${suggestedWeight} kg (calculée pour viser RPE ${targetRpe}).`,
    };
  }

  // 4. Charge OK, mais pas encore les reps
  if (Math.abs(reference.rpe - targetRpe) <= 0.5 && reference.reps < targetReps) {
    return {
      strategy: 'increase_reps',
      suggestedWeight: reference.weightKg,
      suggestedReps: Math.min(targetReps, reference.reps + 1),
      suggestedRpe: targetRpe,
      confidence: 0.75,
      rationale: 'Même charge, vise +1 rep (double progression).',
    };
  }

  // 5. Trop dur mais pas deload
  if (reference.rpe > targetRpe + 0.5) {
    return {
      strategy: 'hold',
      suggestedWeight: reference.weightKg,
      suggestedReps: targetReps,
      suggestedRpe: targetRpe,
      confidence: 0.6,
      rationale: `RPE ${reference.rpe} > cible ${targetRpe} — consolider avant d'augmenter.`,
    };
  }

  return {
    strategy: 'hold',
    suggestedWeight: reference.weightKg,
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

// ─── Suggestion de charge de départ (profil-aware) ─────────────────────────

export type ExerciseCategory =
  | 'squat'
  | 'bench'
  | 'deadlift'
  | 'overhead_press'
  | 'row'
  | 'pull'
  | 'accessory_compound'
  | 'isolation'
  | 'bodyweight';

export type StrengthLevel = 'beginner' | 'intermediate' | 'advanced';

export type ProgressionSex = 'male' | 'female' | 'other';

export interface StartingWeightInput {
  category: ExerciseCategory;
  bodyweightKg: number;
  level: StrengthLevel;
  sex?: ProgressionSex;
  incrementKg?: number; // défaut 2.5
  targetReps?: number; // défaut 8 (zone hypertrophie)
}

export interface StartingWeightSuggestion {
  weightKg: number;
  rationale: string;
  confidence: number; // 0..1
}

/**
 * Multiplicateurs poids-corporel pour un 1RM "raisonnable" par catégorie + niveau.
 *
 * Sources :
 *   - Symmetric Strength / ExRx standards (males) pour benchmarks intermédiaires
 *   - Helms et al. — Strength training pyramid (gender deltas)
 *   - Greg Nuckols' "Beginner / Intermediate / Advanced" ratios
 *
 * Les valeurs sont des 1RM cibles. On dérive ensuite le poids de travail à
 * la cible reps en inversant Epley (intensité ~ 1 - reps/30 = working / 1RM).
 */
const MALE_1RM_RATIOS: Record<ExerciseCategory, Record<StrengthLevel, number>> = {
  squat: { beginner: 0.8, intermediate: 1.25, advanced: 1.75 },
  bench: { beginner: 0.6, intermediate: 1.0, advanced: 1.4 },
  deadlift: { beginner: 1.0, intermediate: 1.5, advanced: 2.1 },
  overhead_press: { beginner: 0.4, intermediate: 0.65, advanced: 0.95 },
  row: { beginner: 0.55, intermediate: 0.85, advanced: 1.15 },
  pull: { beginner: 0.45, intermediate: 0.7, advanced: 1.0 },
  accessory_compound: { beginner: 0.5, intermediate: 0.75, advanced: 1.05 },
  isolation: { beginner: 0.15, intermediate: 0.25, advanced: 0.4 },
  bodyweight: { beginner: 0, intermediate: 0, advanced: 0 },
};

// Coefficient féminin (sur 1RM) — ~75 % haut du corps, ~85 % bas du corps.
const FEMALE_RATIO_FACTOR: Record<ExerciseCategory, number> = {
  squat: 0.85,
  bench: 0.7,
  deadlift: 0.82,
  overhead_press: 0.65,
  row: 0.72,
  pull: 0.65,
  accessory_compound: 0.75,
  isolation: 0.7,
  bodyweight: 1,
};

/**
 * suggestStartingWeight — recommande une charge de travail pour un athlète
 * qui n'a aucun historique sur l'exercice. Sans cette fonction, l'app sort
 * "0 kg, choisis quelque chose" — friction inutile à l'onboarding.
 *
 * Stratégie :
 *   1. 1RM estimé = bodyweight × ratio(catégorie, niveau, sexe)
 *   2. Charge de travail = 1RM × (1 - targetReps/30)  // Epley inverse
 *   3. Arrondi au pas (incrementKg), borné à ≥ 0
 *
 * Confiance : 0.4 (toujours à valider après le 1er set).
 */
export function suggestStartingWeight(input: StartingWeightInput): StartingWeightSuggestion {
  const { category, bodyweightKg, level, sex = 'male', incrementKg = 2.5, targetReps = 8 } = input;

  if (category === 'bodyweight') {
    return {
      weightKg: 0,
      rationale: 'Exercice au poids du corps — pas de charge externe.',
      confidence: 1,
    };
  }

  if (!Number.isFinite(bodyweightKg) || bodyweightKg <= 0) {
    return {
      weightKg: 0,
      rationale: 'Renseigne ton poids corporel dans Profil pour obtenir une suggestion de départ.',
      confidence: 0,
    };
  }

  const baseRatio = MALE_1RM_RATIOS[category][level];
  const factor = sex === 'female' ? FEMALE_RATIO_FACTOR[category] : 1;
  const oneRm = bodyweightKg * baseRatio * factor;

  // Epley inverse : working ≈ 1RM × (1 − reps/30)
  const reps = Math.max(1, Math.min(20, Math.floor(targetReps)));
  const intensity = 1 - reps / 30;
  const raw = oneRm * intensity;
  const weight = Math.max(0, roundTo(raw, incrementKg));

  const sexLabel = sex === 'female' ? 'F' : sex === 'male' ? 'M' : '';
  return {
    weightKg: weight,
    rationale: `Estimation ${sexLabel} ${level} : ~${oneRm.toFixed(0)} kg max → ${weight} kg × ${reps} (≈ ${(intensity * 100).toFixed(0)} % 1RM). Ajuste après ton 1er set.`,
    confidence: 0.4,
  };
}

/**
 * Helper : déduit la catégorie d'un exercice à partir d'IDs courants ou de muscles.
 * Heuristique simple, conservatrice — bascule sur 'isolation' par défaut.
 */
export function inferExerciseCategory(opts: {
  exerciseId?: string;
  muscles?: readonly string[];
  isCompound?: boolean;
}): ExerciseCategory {
  const id = (opts.exerciseId ?? '').toLowerCase();
  if (/squat/.test(id)) return 'squat';
  if (/bench|developpe-couche|developpe_couche|bench-press/.test(id)) return 'bench';
  if (/deadlift|souleve-de-terre|souleve_de_terre/.test(id)) return 'deadlift';
  if (/overhead|ohp|developpe-militaire|developpe_militaire/.test(id)) return 'overhead_press';
  if (/row|rowing|tirage-horizontal/.test(id)) return 'row';
  if (/pull-up|chin-up|traction|pullup|chinup/.test(id)) return 'pull';
  const muscles = new Set(opts.muscles ?? []);
  if (opts.isCompound) return 'accessory_compound';
  if (muscles.has('quads') || muscles.has('hamstrings') || muscles.has('glutes')) {
    return 'accessory_compound';
  }
  return 'isolation';
}
