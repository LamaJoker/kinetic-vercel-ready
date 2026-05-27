import { describe, it, expect } from 'vitest';
import {
  suggestSubstitutions,
  type ExerciseLike,
} from '../../packages/core/src/domain/exercise-substitution.domain.js';

const TARGET: ExerciseLike = {
  id: 'bench-press',
  name: 'Bench Press',
  muscles: ['chest', 'triceps', 'shoulders'],
  equipment: ['barbell', 'bench'],
  pattern: 'push',
};

const CATALOG: ExerciseLike[] = [
  TARGET,
  {
    id: 'dumbbell-bench-press',
    name: 'Dumbbell Bench Press',
    muscles: ['chest', 'triceps', 'shoulders'],
    equipment: ['dumbbell', 'bench'],
    pattern: 'push',
  },
  {
    id: 'push-up',
    name: 'Push-Up',
    muscles: ['chest', 'triceps', 'shoulders', 'core'],
    pattern: 'push',
  },
  {
    id: 'pull-up',
    name: 'Pull-Up',
    muscles: ['back', 'biceps'],
    pattern: 'pull',
  },
  {
    id: 'leg-press',
    name: 'Leg Press',
    muscles: ['quads', 'glutes'],
    pattern: 'squat',
  },
];

describe('suggestSubstitutions', () => {
  it('exclut toujours la cible elle-même', () => {
    const result = suggestSubstitutions({ target: TARGET, candidates: CATALOG });
    expect(result.find((r) => r.exercise.id === 'bench-press')).toBeUndefined();
  });

  it('priorise les exercices avec même pattern moteur', () => {
    const result = suggestSubstitutions({ target: TARGET, candidates: CATALOG, limit: 5 });
    expect(result[0]!.exercise.pattern).toBe('push');
  });

  it('filtre par équipement disponible quand fourni', () => {
    const result = suggestSubstitutions({
      target: TARGET,
      candidates: CATALOG,
      availableEquipment: ['bodyweight'], // ni barbell ni dumbbell
    });
    // Seul push-up (sans equipement requis) reste
    const ids = result.map((r) => r.exercise.id);
    expect(ids).not.toContain('dumbbell-bench-press');
    expect(ids).toContain('push-up');
  });

  it('exclut les exercices qui sollicitent un muscle à éviter', () => {
    const result = suggestSubstitutions({
      target: TARGET,
      candidates: CATALOG,
      avoidMuscles: ['shoulders'],
    });
    // Tous les push candidates sollicitent shoulders → ils sont exclus
    expect(result.find((r) => r.exercise.pattern === 'push')).toBeUndefined();
  });

  it('exclut les exercices sans recouvrement musculaire', () => {
    const result = suggestSubstitutions({ target: TARGET, candidates: CATALOG });
    expect(result.find((r) => r.exercise.id === 'leg-press')).toBeUndefined();
  });

  it('respecte le limit (défaut 3)', () => {
    const result = suggestSubstitutions({ target: TARGET, candidates: CATALOG });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('score décroissant', () => {
    const result = suggestSubstitutions({ target: TARGET, candidates: CATALOG, limit: 5 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.score).toBeLessThanOrEqual(result[i - 1]!.score);
    }
  });
});
