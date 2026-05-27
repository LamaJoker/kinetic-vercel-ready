import { describe, it, expect } from 'vitest';
import {
  applyDeloadToWeek,
  deloadWeightFromHistory,
} from '../../packages/core/src/domain/deload.domain.js';
import type { PerformedSet } from '../../packages/core/src/domain/progression.domain.js';

// Helpers pour fabriquer un historique
function setAt(daysAgo: number, weight: number, reps: number, rpe: number): PerformedSet {
  const at = new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
  return { weightKg: weight, reps, rpe, at };
}

describe('applyDeloadToWeek', () => {
  const week = [
    { exerciseId: 'squat', sets: 5, targetReps: 5, targetRpe: 8 },
    { exerciseId: 'bench', sets: 4, targetReps: 8, targetRpe: 8 },
    { exerciseId: 'row', sets: 3, targetReps: 10, targetRpe: 7 },
  ];

  it('ne touche pas la semaine si aucun exercice ne nécessite un deload', () => {
    const plan = applyDeloadToWeek({
      exercises: week,
      historyByExercise: {
        squat: [
          setAt(10, 100, 5, 7),
          setAt(8, 100, 5, 7),
          setAt(6, 100, 5, 7.5),
          setAt(4, 102.5, 5, 7.5),
          setAt(2, 102.5, 5, 8),
        ],
      },
    });
    expect(plan.triggered).toBe(false);
    expect(plan.triggeredBy).toEqual([]);
    expect(plan.exercises[0]!.sets).toBe(5); // inchangé
  });

  it('déclenche un deload global si un exo a RPE chronique haut sans progression', () => {
    const stagnant: PerformedSet[] = [
      setAt(12, 140, 3, 9),
      setAt(10, 140, 3, 9),
      setAt(8, 140, 3, 9.5),
      setAt(6, 140, 3, 9.5),
      setAt(4, 137.5, 3, 9.5),
    ];
    const plan = applyDeloadToWeek({
      exercises: week,
      historyByExercise: { squat: stagnant },
    });
    expect(plan.triggered).toBe(true);
    expect(plan.triggeredBy).toContain('squat');
    // Volume réduit (60 %)
    expect(plan.exercises[0]!.sets).toBeLessThan(5);
    expect(plan.exercises[0]!.sets).toBeGreaterThanOrEqual(1);
    // RPE cible réduit (8 → 6.5)
    expect(plan.exercises[0]!.targetRpe).toBeLessThanOrEqual(7);
    expect(plan.exercises[0]!.targetRpe).toBeGreaterThanOrEqual(6);
    // Reason flag
    const squat = plan.exercises.find((e) => e.exerciseId === 'squat');
    expect(squat!.reason).toBe('needs_deload');
    const bench = plan.exercises.find((e) => e.exerciseId === 'bench');
    expect(bench!.reason).toBe('companion');
  });

  it('ne crash pas avec un exo sans historique', () => {
    const plan = applyDeloadToWeek({
      exercises: week,
      historyByExercise: {},
    });
    expect(plan.triggered).toBe(false);
  });
});

describe('deloadWeightFromHistory', () => {
  it('retourne 0 si historique vide', () => {
    expect(deloadWeightFromHistory([], 2.5)).toBe(0);
  });

  it('retourne 90 % du dernier poids arrondi à l’incrément', () => {
    const history: PerformedSet[] = [setAt(2, 100, 5, 9)];
    // 100 * 0.9 = 90, déjà multiple de 2.5
    expect(deloadWeightFromHistory(history, 2.5)).toBe(90);
  });

  it('arrondit correctement avec un incrément de 5 kg', () => {
    const history: PerformedSet[] = [setAt(1, 120, 5, 9)];
    // 120 * 0.9 = 108 → arrondi au 5 le plus proche = 110
    expect(deloadWeightFromHistory(history, 5)).toBe(110);
  });
});
