/**
 * Weekly Review Domain — bilan de la semaine d'entraînement.
 *
 * Agrège les sets d'une semaine ISO (tonnage, séances, jours, exercices, PR) et
 * compare à la semaine précédente. Sert un écran « ta semaine » motivant, sans
 * dépendre du push : c'est de l'agrégation pure réutilisant analytics.domain.
 *
 * Pur — aucune dépendance externe, aucun I/O.
 */

import {
  type AnalyticsSet,
  type PersonalRecord,
  toIsoWeek,
  detectPRs,
} from './analytics.domain.js';

export interface WeeklyReview {
  /** Semaine ISO du bilan ("YYYY-Www"). */
  isoWeek: string;
  tonnageKg: number;
  totalSets: number;
  totalReps: number;
  /** Séances distinctes (par sessionId). */
  sessions: number;
  /** Jours d'entraînement distincts (date calendaire). */
  trainingDays: number;
  /** Exercices distincts travaillés. */
  exercises: number;
  /** Records personnels (e1RM) battus cette semaine. */
  prs: PersonalRecord[];
  prCount: number;
  /** Tonnage de la semaine précédente (0 si aucune donnée). */
  prevTonnageKg: number;
  /** Variation de tonnage vs semaine précédente, en %. null si pas de semaine précédente. */
  tonnageDeltaPct: number | null;
  /** Tendance lisible : première semaine de données, en hausse, en baisse, stable. */
  trend: 'first' | 'up' | 'down' | 'flat';
}

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Seuil de variation considéré comme « stable » (bruit hebdomadaire). */
const FLAT_THRESHOLD_PCT = 2;

function uniqueCount<T>(items: readonly AnalyticsSet[], pick: (s: AnalyticsSet) => T): number {
  const set = new Set<T>();
  for (const s of items) set.add(pick(s));
  return set.size;
}

function tonnage(sets: readonly AnalyticsSet[]): number {
  return sets.reduce((sum, s) => sum + s.reps * s.weightKg, 0);
}

/**
 * buildWeeklyReview — construit le bilan de la semaine contenant `referenceIso`
 * (par défaut : maintenant), comparé à la semaine précédente.
 */
export function buildWeeklyReview(
  sets: readonly AnalyticsSet[],
  referenceIso: string = new Date().toISOString(),
): WeeklyReview {
  const thisWeek = toIsoWeek(referenceIso);
  const prevWeek = toIsoWeek(new Date(Date.parse(referenceIso) - 7 * DAY_MS).toISOString());

  const weekSets = sets.filter((s) => toIsoWeek(s.performedAt) === thisWeek);
  const prevTonnageKg = Math.round(
    tonnage(sets.filter((s) => toIsoWeek(s.performedAt) === prevWeek)),
  );

  const tonnageKg = Math.round(tonnage(weekSets));

  const prs = detectPRs(sets).filter((pr) => toIsoWeek(pr.achievedAt) === thisWeek);

  let tonnageDeltaPct: number | null = null;
  let trend: WeeklyReview['trend'];
  if (prevTonnageKg > 0) {
    tonnageDeltaPct = Math.round(((tonnageKg - prevTonnageKg) / prevTonnageKg) * 100);
    if (tonnageDeltaPct > FLAT_THRESHOLD_PCT) trend = 'up';
    else if (tonnageDeltaPct < -FLAT_THRESHOLD_PCT) trend = 'down';
    else trend = 'flat';
  } else {
    // Pas de tonnage la semaine précédente → première semaine de données (ou reprise).
    trend = tonnageKg > 0 ? 'first' : 'flat';
  }

  return {
    isoWeek: thisWeek,
    tonnageKg,
    totalSets: weekSets.length,
    totalReps: weekSets.reduce((sum, s) => sum + s.reps, 0),
    sessions: uniqueCount(weekSets, (s) => s.sessionId),
    trainingDays: uniqueCount(weekSets, (s) => s.performedAt.slice(0, 10)),
    exercises: uniqueCount(weekSets, (s) => s.exerciseId),
    prs,
    prCount: prs.length,
    prevTonnageKg,
    tonnageDeltaPct,
    trend,
  };
}
