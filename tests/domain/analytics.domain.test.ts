import { describe, it, expect } from 'vitest';
import {
  weeklyVolume,
  perExerciseStats,
  muscleDistribution,
  detectPRs,
  toIsoWeek,
  type AnalyticsSet,
} from '@kinetic/core';

function s(
  exerciseId: string,
  muscles: string[],
  reps: number,
  weightKg: number,
  dayOffset: number,
  rpe = 8,
): AnalyticsSet {
  const d = new Date('2025-01-06T12:00:00Z'); // lundi, semaine 2025-W02
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return {
    sessionId: `sess-${dayOffset}`,
    exerciseId,
    muscles,
    reps,
    weightKg,
    rpe,
    performedAt: d.toISOString(),
  };
}

describe('toIsoWeek', () => {
  it('retourne 2025-W02 pour lundi 6 janvier 2025', () => {
    expect(toIsoWeek('2025-01-06T10:00:00Z')).toBe('2025-W02');
  });

  it('retourne 2025-W01 pour jeudi 2 janvier 2025', () => {
    expect(toIsoWeek('2025-01-02T10:00:00Z')).toBe('2025-W01');
  });
});

describe('weeklyVolume', () => {
  it('agrège tonnage, sets et reps par semaine ISO', () => {
    const sets = [
      s('squat', ['jambes'], 5, 100, 0), // W02
      s('squat', ['jambes'], 5, 100, 0), // W02
      s('squat', ['jambes'], 5, 100, 7), // W03
    ];
    const v = weeklyVolume(sets);
    expect(v).toHaveLength(2);
    expect(v[0]!.isoWeek).toBe('2025-W02');
    expect(v[0]!.tonnageKg).toBe(1000);
    expect(v[0]!.totalSets).toBe(2);
    expect(v[0]!.totalReps).toBe(10);
    expect(v[1]!.isoWeek).toBe('2025-W03');
  });

  it('est trié par semaine ascendante', () => {
    const sets = [s('x', ['a'], 1, 1, 14), s('x', ['a'], 1, 1, 0), s('x', ['a'], 1, 1, 7)];
    const v = weeklyVolume(sets);
    expect(v.map((b) => b.isoWeek)).toEqual([...v.map((b) => b.isoWeek)].sort());
  });
});

describe('perExerciseStats', () => {
  it('calcule tonnage et meilleur e1RM', () => {
    const sets = [
      s('bench', ['pecs'], 5, 80, 0),
      s('bench', ['pecs'], 5, 85, 2),
      s('bench', ['pecs'], 3, 90, 4),
    ];
    const [stat] = perExerciseStats(sets);
    expect(stat!.exerciseId).toBe('bench');
    expect(stat!.tonnageKg).toBe(5 * 80 + 5 * 85 + 3 * 90);
    expect(stat!.bestE1rmKg).toBeCloseTo(85 * (1 + 5 / 30));
  });

  it('trie par tonnage décroissant', () => {
    const sets = [s('a', ['x'], 5, 100, 0), s('b', ['x'], 5, 200, 0)];
    const stats = perExerciseStats(sets);
    expect(stats[0]!.exerciseId).toBe('b');
    expect(stats[1]!.exerciseId).toBe('a');
  });
});

describe('muscleDistribution', () => {
  it('répartit un set entre les muscles impliqués', () => {
    const sets = [s('bench', ['pecs', 'triceps'], 8, 80, 0)];
    const dist = muscleDistribution(sets);
    expect(dist).toHaveLength(2);
    expect(dist[0]!.share).toBeCloseTo(0.5);
    expect(dist[1]!.share).toBeCloseTo(0.5);
  });

  it('retourne un tableau vide sans muscles renseignés', () => {
    const sets = [s('x', [], 8, 80, 0)];
    expect(muscleDistribution(sets)).toEqual([]);
  });
});

describe('detectPRs', () => {
  it('ne remonte que les e1RM strictement croissants', () => {
    const sets = [
      s('squat', ['jambes'], 5, 100, 0), // e1RM ≈ 116.7
      s('squat', ['jambes'], 5, 100, 2), // égal — pas un PR
      s('squat', ['jambes'], 3, 110, 4), // e1RM = 121 → PR
      s('squat', ['jambes'], 5, 100, 6), // redescend — pas un PR
    ];
    const prs = detectPRs(sets);
    expect(prs).toHaveLength(2);
    expect(prs[0]!.weightKg).toBe(100);
    expect(prs[1]!.weightKg).toBe(110);
  });
});
