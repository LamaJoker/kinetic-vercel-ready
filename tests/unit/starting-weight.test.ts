import { describe, it, expect } from 'vitest';
import {
  suggestStartingWeight,
  inferExerciseCategory,
} from '../../packages/core/src/domain/progression.domain.js';

describe('suggestStartingWeight', () => {
  it('retourne 0 pour bodyweight', () => {
    const r = suggestStartingWeight({
      category: 'bodyweight',
      bodyweightKg: 75,
      level: 'intermediate',
    });
    expect(r.weightKg).toBe(0);
    expect(r.confidence).toBe(1);
  });

  it('retourne 0 si bodyweight inconnu', () => {
    const r = suggestStartingWeight({
      category: 'bench',
      bodyweightKg: 0,
      level: 'beginner',
    });
    expect(r.weightKg).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.rationale.toLowerCase()).toContain('poids corporel');
  });

  it('produit une charge raisonnable pour un benchmark intermédiaire (homme 80 kg, bench)', () => {
    const r = suggestStartingWeight({
      category: 'bench',
      bodyweightKg: 80,
      level: 'intermediate',
      sex: 'male',
      incrementKg: 2.5,
      targetReps: 8,
    });
    // 1RM ≈ 80, intensité @ 8 reps ≈ 73 % → ~60 kg
    expect(r.weightKg).toBeGreaterThanOrEqual(50);
    expect(r.weightKg).toBeLessThanOrEqual(65);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('applique un coefficient féminin (charge plus basse à profil égal)', () => {
    const male = suggestStartingWeight({
      category: 'squat',
      bodyweightKg: 70,
      level: 'intermediate',
      sex: 'male',
    });
    const female = suggestStartingWeight({
      category: 'squat',
      bodyweightKg: 70,
      level: 'intermediate',
      sex: 'female',
    });
    expect(female.weightKg).toBeLessThan(male.weightKg);
  });

  it('niveau advanced > intermediate > beginner', () => {
    const args = { category: 'deadlift' as const, bodyweightKg: 80, sex: 'male' as const };
    const b = suggestStartingWeight({ ...args, level: 'beginner' }).weightKg;
    const i = suggestStartingWeight({ ...args, level: 'intermediate' }).weightKg;
    const a = suggestStartingWeight({ ...args, level: 'advanced' }).weightKg;
    expect(a).toBeGreaterThan(i);
    expect(i).toBeGreaterThan(b);
  });

  it("snap la charge à l'incrément fourni", () => {
    const r = suggestStartingWeight({
      category: 'bench',
      bodyweightKg: 77,
      level: 'intermediate',
      incrementKg: 5,
    });
    expect(r.weightKg % 5).toBe(0);
  });
});

describe('inferExerciseCategory', () => {
  it.each([
    ['back-squat', 'squat'],
    ['bench-press', 'bench'],
    ['developpe-couche', 'bench'],
    ['deadlift', 'deadlift'],
    ['souleve-de-terre', 'deadlift'],
    ['overhead-press', 'overhead_press'],
    ['ohp', 'overhead_press'],
    ['barbell-row', 'row'],
    ['pull-up', 'pull'],
    ['traction', 'pull'],
  ])('classe %s comme %s', (id, expected) => {
    expect(inferExerciseCategory({ exerciseId: id })).toBe(expected);
  });

  it("retombe sur 'isolation' si l'id est inconnu et aucun muscle compound", () => {
    expect(inferExerciseCategory({ exerciseId: 'curl-biceps' })).toBe('isolation');
  });

  it("classe en 'accessory_compound' si le muscle est un grand groupe", () => {
    expect(inferExerciseCategory({ exerciseId: 'unknown', muscles: ['quads'] })).toBe(
      'accessory_compound',
    );
  });
});
