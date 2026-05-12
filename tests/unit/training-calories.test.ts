import { describe, it, expect } from 'vitest';
import { estimateStrengthWorkoutCaloriesKcal } from '../../apps/web/src/lib/training/calories.js';

describe('estimateStrengthWorkoutCaloriesKcal', () => {
  const profile = { weightKg: 80 };

  it('returns 0 for zero duration', () => {
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 0, avgRpe: 8, profile })).toBe(0);
  });

  it('returns null when profile is null', () => {
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile: null })).toBeNull();
  });

  it('returns null when weightKg is 0 or negative', () => {
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile: { weightKg: 0 } })).toBeNull();
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile: { weightKg: -10 } })).toBeNull();
  });

  it('computes kcal using MET formula for moderate RPE', () => {
    // RPE 8 → delta=(8-6)*0.5=1 → MET=4.5; kcal=4.5*3.5*80/200*60
    const expected = Math.round(4.5 * 3.5 * 80 / 200 * 60);
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile })).toBe(expected);
  });

  it('uses MET 3.5 for RPE 6 (minimum)', () => {
    const expected = Math.round(3.5 * 3.5 * 80 / 200 * 60);
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 6, profile })).toBe(expected);
  });

  it('uses MET 5.5 for RPE 10 (clamp formula: 3.5 + (10-6)*0.5 = 5.5)', () => {
    // MET = clamp(3.5 + (rpe-6)*0.5, 3.5, 6.0) = clamp(3.5+2, 3.5, 6.0) = 5.5
    const expected = Math.round(5.5 * 3.5 * 80 / 200 * 60);
    expect(estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 10, profile })).toBe(expected);
  });

  it('defaults avgRpe to 8 when null', () => {
    const withNull = estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: null, profile });
    const withEight = estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile });
    expect(withNull).toBe(withEight);
  });

  it('clamps duration to 600 min max', () => {
    const at600 = estimateStrengthWorkoutCaloriesKcal({ durationMin: 600, avgRpe: 8, profile });
    const at999 = estimateStrengthWorkoutCaloriesKcal({ durationMin: 999, avgRpe: 8, profile });
    expect(at600).toBe(at999);
  });

  it('scales linearly with duration', () => {
    const at30 = estimateStrengthWorkoutCaloriesKcal({ durationMin: 30, avgRpe: 8, profile })!;
    const at60 = estimateStrengthWorkoutCaloriesKcal({ durationMin: 60, avgRpe: 8, profile })!;
    // Math.round introduces ±1 difference
    expect(Math.abs(at60 - at30 * 2)).toBeLessThanOrEqual(1);
  });
});
