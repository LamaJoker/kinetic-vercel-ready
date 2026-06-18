/**
 * Deload Advisor Domain — recommandation de semaine de décharge (deload).
 *
 * Combine deux signaux complémentaires, à l'échelle de la planification :
 *   1. VOLUME — sets hebdomadaires par muscle vs MRV (Maximum Recoverable
 *      Volume). Au-delà du MRV, le volume ne progresse plus et la fatigue
 *      s'accumule → deload. Repères RP / Israetel (sets/sem, intermédiaire).
 *   2. FATIGUE — `needsDeload()` par exercice (RPE moyen élevé + e1RM stagnant
 *      sur les 5 dernières séances). Capte la fatigue même sous le MRV.
 *
 * Sources volume :
 *   - Israetel et al. — Scientific Principles of Strength Training (volume landmarks)
 *   - Renaissance Periodization — MEV/MAV/MRV par groupe musculaire
 *
 * Pur — aucune dépendance externe, aucun I/O.
 */

import { type AnalyticsSet, toIsoWeek } from './analytics.domain.js';
import { needsDeload, type PerformedSet } from './progression.domain.js';

/**
 * MRV par muscle (sets de travail / semaine), repères intermédiaires.
 * Seuls les muscles avec un repère défendable sont listés ; les autres ne sont
 * pas plafonnés (pas de faux positif). Clés alignées sur le vocabulaire muscles
 * de l'app (cf. exercises.v1.json).
 */
export const DEFAULT_MRV: Readonly<Record<string, number>> = {
  chest: 22,
  back: 25,
  upper_back: 25,
  lower_back: 12,
  lats: 25,
  quads: 20,
  hamstrings: 16,
  glutes: 16,
  shoulders: 26,
  rear_delts: 26,
  traps: 20,
  biceps: 20,
  triceps: 18,
  forearms: 16,
  calves: 20,
  core: 25,
  abs: 25,
};

/** Fraction du MRV à partir de laquelle on commence à surveiller. */
const APPROACH_RATIO = 0.9;

export interface MuscleVolume {
  muscle: string;
  weeklySets: number;
  mrv: number;
  /** weeklySets / mrv. >= 1 = au-delà du MRV. */
  ratio: number;
}

export interface DeloadRecommendation {
  shouldDeload: boolean;
  severity: 'none' | 'monitor' | 'recommended';
  reasons: string[];
  /** Muscles dont le volume hebdo atteint ou dépasse le MRV. */
  overReached: MuscleVolume[];
  /** Muscles approchant le MRV (≥ 90 %), sans l'atteindre. */
  approaching: MuscleVolume[];
  /** Exercices signalés fatigués par needsDeload (RPE haut + e1RM plat). */
  fatiguedExercises: string[];
}

export interface DeloadAdvisorOptions {
  referenceIso?: string;
  /** Surcharge des seuils MRV (fusionnée avec les valeurs par défaut). */
  mrvByMuscle?: Readonly<Record<string, number>>;
}

function bySeverity(a: MuscleVolume, b: MuscleVolume): number {
  return b.ratio - a.ratio;
}

/**
 * buildDeloadRecommendation — évalue le besoin de deload pour la semaine
 * contenant `referenceIso` (par défaut : maintenant).
 */
export function buildDeloadRecommendation(
  sets: readonly AnalyticsSet[],
  opts: DeloadAdvisorOptions = {},
): DeloadRecommendation {
  const referenceIso = opts.referenceIso ?? new Date().toISOString();
  const mrv = { ...DEFAULT_MRV, ...(opts.mrvByMuscle ?? {}) };
  const thisWeek = toIsoWeek(referenceIso);

  // ── 1. Volume hebdo par muscle ──────────────────────────────────────────
  const weekSets = sets.filter((s) => toIsoWeek(s.performedAt) === thisWeek);
  const setsPerMuscle = new Map<string, number>();
  for (const s of weekSets) {
    for (const m of s.muscles) {
      setsPerMuscle.set(m, (setsPerMuscle.get(m) ?? 0) + 1);
    }
  }

  const overReached: MuscleVolume[] = [];
  const approaching: MuscleVolume[] = [];
  for (const [muscle, weeklySets] of setsPerMuscle) {
    const cap = mrv[muscle];
    if (!cap) continue; // muscle sans repère → non plafonné
    const ratio = weeklySets / cap;
    const entry: MuscleVolume = {
      muscle,
      weeklySets,
      mrv: cap,
      ratio: Math.round(ratio * 100) / 100,
    };
    if (ratio >= 1) overReached.push(entry);
    else if (ratio >= APPROACH_RATIO) approaching.push(entry);
  }
  overReached.sort(bySeverity);
  approaching.sort(bySeverity);

  // ── 2. Fatigue par exercice (needsDeload) ───────────────────────────────
  const historyByExercise = new Map<string, PerformedSet[]>();
  for (const s of sets) {
    const list = historyByExercise.get(s.exerciseId) ?? [];
    list.push({ reps: s.reps, weightKg: s.weightKg, rpe: s.rpe, at: s.performedAt });
    historyByExercise.set(s.exerciseId, list);
  }
  const fatiguedExercises: string[] = [];
  for (const [exerciseId, history] of historyByExercise) {
    const ordered = [...history].sort((a, b) => a.at.localeCompare(b.at));
    if (needsDeload(ordered)) fatiguedExercises.push(exerciseId);
  }
  fatiguedExercises.sort();

  // ── 3. Synthèse ─────────────────────────────────────────────────────────
  const reasons: string[] = [];
  for (const m of overReached) {
    reasons.push(
      `${m.muscle} : ${m.weeklySets} sets cette semaine (MRV ≈ ${m.mrv}) — au-delà du volume récupérable.`,
    );
  }
  if (fatiguedExercises.length > 0) {
    reasons.push(
      `Fatigue détectée sur ${fatiguedExercises.length} exercice(s) (RPE élevé sans gain d'e1RM) : ${fatiguedExercises.join(', ')}.`,
    );
  }
  for (const m of approaching) {
    reasons.push(`${m.muscle} : ${m.weeklySets} sets, proche du MRV (${m.mrv}) — à surveiller.`);
  }

  const shouldDeload = overReached.length > 0 || fatiguedExercises.length > 0;
  const severity: DeloadRecommendation['severity'] = shouldDeload
    ? 'recommended'
    : approaching.length > 0
      ? 'monitor'
      : 'none';

  return { shouldDeload, severity, reasons, overReached, approaching, fatiguedExercises };
}
