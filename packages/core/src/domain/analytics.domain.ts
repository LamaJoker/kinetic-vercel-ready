/**
 * Analytics Domain — agrégations de performance pour le dashboard progression.
 *
 * Entrées : liste d'AnalyticsSet (projection applicative des WorkoutSession).
 * Sorties : volume hebdo, tonnage, e1RM max par exercice, heatmap muscles,
 *           cadence des PR (personal records), évolution temporelle.
 *
 * Pur — aucune dépendance, aucun I/O.
 */

import { e1rm } from './progression.domain.js';

// ─── Types d'entrée ──────────────────────────────────────────────────────────

export interface AnalyticsSet {
  sessionId:  string;
  exerciseId: string;
  muscles:    readonly string[];
  reps:       number;
  weightKg:   number;
  rpe:        number;
  performedAt: string;         // ISO datetime
}

// ─── Agrégats ────────────────────────────────────────────────────────────────

export interface VolumeBucket {
  isoWeek:   string;          // "2025-W03"
  tonnageKg: number;          // Σ reps × weightKg
  totalSets: number;
  totalReps: number;
}

export interface ExerciseStats {
  exerciseId:    string;
  totalSets:     number;
  totalReps:     number;
  tonnageKg:     number;
  bestE1rmKg:    number;
  bestE1rmAt:    string;
  lastPerformed: string;
}

export interface MuscleShare {
  muscle: string;
  sets:   number;
  share:  number;              // 0..1
}

export interface PersonalRecord {
  exerciseId: string;
  e1rmKg:     number;
  weightKg:   number;
  reps:       number;
  achievedAt: string;
}

// ─── Helpers dates ───────────────────────────────────────────────────────────

/** ISO week label "YYYY-Www". Implémentation basée sur jeudi de la semaine. */
export function toIsoWeek(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;   // lundi=0
  d.setUTCDate(d.getUTCDate() - day + 3); // jeudi de la semaine courante
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d.getTime() - firstThursday.getTime()) / 86_400_000;
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ─── Agrégations ─────────────────────────────────────────────────────────────

/**
 * weeklyVolume — tonnage et volume (sets, reps) par semaine ISO.
 */
export function weeklyVolume(sets: readonly AnalyticsSet[]): VolumeBucket[] {
  const buckets = new Map<string, VolumeBucket>();
  for (const s of sets) {
    const key = toIsoWeek(s.performedAt);
    const cur = buckets.get(key) ?? { isoWeek: key, tonnageKg: 0, totalSets: 0, totalReps: 0 };
    cur.tonnageKg += s.reps * s.weightKg;
    cur.totalSets += 1;
    cur.totalReps += s.reps;
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((a, b) => a.isoWeek.localeCompare(b.isoWeek));
}

/**
 * perExerciseStats — stats par exercice (total, tonnage, meilleur e1RM).
 */
export function perExerciseStats(sets: readonly AnalyticsSet[]): ExerciseStats[] {
  const byEx = new Map<string, ExerciseStats>();
  for (const s of sets) {
    const est = e1rm(s.weightKg, s.reps);
    const cur = byEx.get(s.exerciseId) ?? {
      exerciseId:    s.exerciseId,
      totalSets:     0,
      totalReps:     0,
      tonnageKg:     0,
      bestE1rmKg:    0,
      bestE1rmAt:    s.performedAt,
      lastPerformed: s.performedAt,
    };
    cur.totalSets += 1;
    cur.totalReps += s.reps;
    cur.tonnageKg += s.reps * s.weightKg;
    if (est > cur.bestE1rmKg) {
      cur.bestE1rmKg = est;
      cur.bestE1rmAt = s.performedAt;
    }
    if (s.performedAt > cur.lastPerformed) cur.lastPerformed = s.performedAt;
    byEx.set(s.exerciseId, cur);
  }
  return [...byEx.values()].sort((a, b) => b.tonnageKg - a.tonnageKg);
}

/**
 * muscleDistribution — répartition par groupe musculaire (heatmap).
 * Un set qui travaille 2 muscles compte 0.5 pour chacun.
 */
export function muscleDistribution(sets: readonly AnalyticsSet[]): MuscleShare[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of sets) {
    if (s.muscles.length === 0) continue;
    const share = 1 / s.muscles.length;
    for (const m of s.muscles) {
      counts.set(m, (counts.get(m) ?? 0) + share);
      total += share;
    }
  }
  if (total === 0) return [];
  return [...counts.entries()]
    .map(([muscle, sets]) => ({ muscle, sets, share: sets / total }))
    .sort((a, b) => b.sets - a.sets);
}

/**
 * detectPRs — nouveaux records personnels par exercice (e1RM strictement croissant).
 */
export function detectPRs(sets: readonly AnalyticsSet[]): PersonalRecord[] {
  const ordered = [...sets].sort((a, b) => a.performedAt.localeCompare(b.performedAt));
  const best = new Map<string, number>();
  const prs: PersonalRecord[] = [];
  for (const s of ordered) {
    const est = e1rm(s.weightKg, s.reps);
    const prev = best.get(s.exerciseId) ?? 0;
    if (est > prev) {
      best.set(s.exerciseId, est);
      prs.push({
        exerciseId: s.exerciseId,
        e1rmKg:     Math.round(est * 10) / 10,
        weightKg:   s.weightKg,
        reps:       s.reps,
        achievedAt: s.performedAt,
      });
    }
  }
  return prs;
}

/**
 * consistencyScore — % de semaines avec au moins 1 séance sur les N dernières.
 */
export function consistencyScore(sets: readonly AnalyticsSet[], weeks: number = 8): number {
  if (weeks <= 0 || sets.length === 0) return 0;
  const active = new Set(sets.map((s) => toIsoWeek(s.performedAt)));
  const now = new Date();
  let hits = 0;
  for (let i = 0; i < weeks; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 7);
    if (active.has(toIsoWeek(d.toISOString()))) hits += 1;
  }
  return Math.round((hits / weeks) * 100);
}
