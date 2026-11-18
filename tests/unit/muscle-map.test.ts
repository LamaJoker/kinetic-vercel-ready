import { describe, it, expect } from 'vitest';
import {
  buildMuscleMap,
  muscleLevel,
  regionWeights,
  MUSCLE_REGIONS,
  type MuscleMapSession,
} from '../../packages/core/src/domain/muscle-map.domain.js';

const MUSCLES: Record<string, readonly string[]> = {
  bench: ['chest', 'triceps'],
  row: ['back', 'biceps'],
  deadlift: ['posterior', 'back'],
  run: ['conditioning'],
};
const musclesOf = (id: string): readonly string[] => MUSCLES[id] ?? [];
const now = new Date('2026-11-18T12:00:00Z');

function sets(n: number, performedAt: string, weightKg = 100, reps = 5) {
  return Array.from({ length: n }, () => ({ weightKg, reps, performedAt }));
}

describe('regionWeights', () => {
  it('muscle principal 1, secondaires 0,5, étiquettes larges réparties', () => {
    expect(Object.fromEntries(regionWeights(['chest', 'triceps']))).toEqual({
      chest: 1,
      triceps: 0.5,
    });
    expect(Object.fromEntries(regionWeights(['posterior', 'back']))).toEqual({
      hamstrings: 1,
      glutes: 1,
      lower_back: 1,
      lats: 0.5,
      upper_back: 0.5,
    });
  });

  it('garde le poids le plus fort pour une zone citée deux fois ; ignore l’inconnu', () => {
    expect(Object.fromEntries(regionWeights(['back', 'upper_back']))).toEqual({
      lats: 1,
      upper_back: 1,
    });
    expect(regionWeights(['conditioning', 'full_body']).size).toBe(0);
  });

  it('ignore les étiquettes héritées ou invalides venues d’un import', () => {
    const bad = ['toString', 'constructor', '__proto__', 42] as unknown as string[];
    expect(() => regionWeights(bad)).not.toThrow();
    expect(regionWeights(bad).size).toBe(0);
    expect(Object.fromEntries(regionWeights(['hasOwnProperty', 'chest']))).toEqual({ chest: 0.5 });
  });
});

describe('muscleLevel', () => {
  it('paliers en séries par semaine', () => {
    expect(muscleLevel(0)).toBe(0);
    expect(muscleLevel(Number.NaN)).toBe(0);
    expect(muscleLevel(0.5)).toBe(1);
    expect(muscleLevel(3.9)).toBe(1);
    expect(muscleLevel(4)).toBe(2);
    expect(muscleLevel(9.5)).toBe(2);
    expect(muscleLevel(10)).toBe(3);
    expect(muscleLevel(19.9)).toBe(3);
    expect(muscleLevel(20)).toBe(4);
  });
});

describe('buildMuscleMap', () => {
  const sessions: MuscleMapSession[] = [
    {
      startedAt: '2026-11-17T10:00:00Z',
      entries: [
        {
          exerciseId: 'bench',
          sets: [
            { weightKg: 40, reps: 10, performedAt: '2026-11-17T10:00:00Z', kind: 'warmup' },
            ...sets(4, '2026-11-17T10:05:00Z'),
          ],
        },
        { exerciseId: 'row', sets: sets(3, '2026-11-17T10:30:00Z', 60, 10) },
        { exerciseId: 'run', sets: sets(1, '2026-11-17T11:00:00Z', 0, 1) },
      ],
    },
    // Il y a 20 jours : hors 7 j, dans 30 j. Séries sans date → début de séance.
    {
      startedAt: '2026-10-29T10:00:00Z',
      entries: [
        {
          exerciseId: 'bench',
          sets: [
            { weightKg: 100, reps: 5 },
            { weightKg: 100, reps: 5 },
          ],
        },
      ],
    },
  ];

  it('7 jours : séries effectives, tonnage pondéré, exercices, hors échauffements', () => {
    const map = buildMuscleMap({ sessions, musclesOf, days: 7, now });
    expect(map.days).toBe(7);
    expect(map.totalSets).toBe(8);
    expect(map.unmappedSets).toBe(1);
    expect(map.regions.chest).toMatchObject({ sets: 4, setsPerWeek: 4, tonnageKg: 2000, level: 2 });
    expect(map.regions.triceps).toMatchObject({ sets: 2, tonnageKg: 1000, level: 1 });
    expect(map.regions.lats).toMatchObject({ sets: 3, tonnageKg: 1800 });
    expect(map.regions.biceps.sets).toBe(1.5);
    expect(map.regions.chest.exercises).toEqual([{ exerciseId: 'bench', sets: 4 }]);
    expect(map.regions.quads).toMatchObject({ sets: 0, level: 0, exercises: [] });
    expect(map.ranked.map((r) => r.key)).toEqual([
      'chest',
      'lats',
      'upper_back',
      'triceps',
      'biceps',
    ]);
  });

  it('30 jours : inclut la séance ancienne, rythme ramené à la semaine', () => {
    const map = buildMuscleMap({ sessions, musclesOf, days: 30, now });
    expect(map.regions.chest.sets).toBe(6);
    expect(map.regions.chest.setsPerWeek).toBe(1.4);
    expect(map.regions.chest.level).toBe(1);
    expect(map.regions.chest.exercises).toEqual([{ exerciseId: 'bench', sets: 6 }]);
  });

  it('ignore les séries futures et les dates invalides', () => {
    const map = buildMuscleMap({
      sessions: [
        {
          startedAt: 'invalide',
          entries: [
            {
              exerciseId: 'bench',
              sets: [{ weightKg: 1, reps: 1 }, ...sets(1, '2026-11-19T10:00:00Z')],
            },
          ],
        },
      ],
      musclesOf,
      days: 7,
      now,
    });
    expect(map.totalSets).toBe(0);
    expect(map.ranked).toEqual([]);
  });

  it('chaque zone a un libellé et au moins une vue', () => {
    const map = buildMuscleMap({ sessions: [], musclesOf, days: 7, now });
    expect(Object.keys(map.regions)).toHaveLength(MUSCLE_REGIONS.length);
    for (const r of MUSCLE_REGIONS) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.views.length).toBeGreaterThan(0);
    }
  });
});
