/**
 * Records de l'historique, précalculés une fois (PERF-06, écran Séances).
 *
 * Le badge « record » est évalué pour chaque série affichée (2 liaisons par série,
 * 2 par en-tête d'exercice) : relire tout l'historique à chaque fois coûtait
 * O(séries affichées × historique) à chaque saisie. Ici, une passe sur l'historique
 * donne le meilleur e1RM de chaque exercice ; la séance en cours, petite, est
 * combinée à la volée. Mêmes règles que le calcul d'origine : séries de travail
 * seulement, première entrée d'un exercice dans chaque séance.
 */
import { workSetsOf, type TimedBest } from '@kinetic/core';
import { estimateE1rmKg } from './training/rpe';

interface SetLike {
  weightKg: number;
  reps: number;
  kind?: string | undefined;
}
interface EntryLike {
  exerciseId: string;
  sets: readonly SetLike[];
}
interface SessionLike {
  entries: readonly EntryLike[];
}

/** Meilleur e1RM des séries de travail (0 si aucune). */
export function bestE1rmOfSets(sets: readonly SetLike[]): number {
  let best = 0;
  for (const set of workSetsOf(sets)) {
    const e1rm = estimateE1rmKg(set.weightKg, set.reps);
    if (e1rm > best) best = e1rm;
  }
  return best;
}

/** Exercice → meilleur e1RM de l'historique, en une passe. */
export function bestE1rmByExercise(sessions: readonly SessionLike[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const s of sessions) {
    const seen = new Set<string>();
    for (const entry of s.entries) {
      // Comme `entries.find(…)` : seule la première entrée d'un exercice compte.
      if (seen.has(entry.exerciseId)) continue;
      seen.add(entry.exerciseId);
      const e1rm = bestE1rmOfSets(entry.sets);
      if (e1rm > (best.get(entry.exerciseId) ?? 0)) best.set(entry.exerciseId, e1rm);
    }
  }
  return best;
}

/**
 * Record d'un exercice : historique précalculé + séance en cours (dont les séries
 * comptent aussi, pour ne pas célébrer 5 fois la même série). `null` sans record.
 */
export function prWithCurrent(
  historyBest: number | undefined,
  current: SessionLike | null | undefined,
  exerciseId: string,
): number | null {
  let best = historyBest ?? 0;
  const entry = current?.entries.find((e) => e.exerciseId === exerciseId);
  if (entry) best = Math.max(best, bestE1rmOfSets(entry.sets));
  return best > 0 ? best : null;
}

/**
 * Record chronométré de l'historique combiné à celui de la séance en cours : même
 * résultat que `bestTimed([...historique, séanceEnCours])` (à égalité, la série la
 * plus ancienne garde le record).
 */
export function mergeTimedBest(
  history: TimedBest | null,
  current: TimedBest | null,
): TimedBest | null {
  if (!history) return current ? { ...current } : null;
  const best = { ...history };
  if (!current) return best;
  if (current.durationSec > best.durationSec) {
    best.durationSec = current.durationSec;
    best.durationAt = current.durationAt;
    best.weightKg = current.weightKg;
  }
  if (current.distanceM > best.distanceM) {
    best.distanceM = current.distanceM;
    best.distanceAt = current.distanceAt;
  }
  return best;
}
