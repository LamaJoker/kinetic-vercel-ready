import { describe, it, expect } from 'vitest';
import {
  activityMultiplier,
  estimateBmrKcal,
  estimateTdeeKcal,
  goalDeltaKcal,
  estimateTargetCaloriesKcal,
} from '../../apps/web/src/lib/user/nutrition.js';
import type { UserProfile } from '../../apps/web/src/lib/user/types.js';

const baseProfile: UserProfile = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sex: 'male',
  ageYears: 25,
  heightCm: 180,
  weightKg: 80,
  activity: 'moderate',
  goal: 'performance',
};

describe('activityMultiplier', () => {
  it('returns correct multiplier for each level', () => {
    expect(activityMultiplier('sedentary')).toBe(1.2);
    expect(activityMultiplier('light')).toBe(1.375);
    expect(activityMultiplier('moderate')).toBe(1.55);
    expect(activityMultiplier('active')).toBe(1.725);
    expect(activityMultiplier('very_active')).toBe(1.9);
  });

  it('defaults to 1.55 for unknown level', () => {
    expect(activityMultiplier('unknown' as any)).toBe(1.55);
  });
});

describe('estimateBmrKcal (Mifflin-St Jeor)', () => {
  it('computes BMR for male: 10w + 6.25h - 5a + 5', () => {
    const expected = 10 * 80 + 6.25 * 180 - 5 * 25 + 5;
    expect(estimateBmrKcal(baseProfile)).toBeCloseTo(expected, 1);
  });

  it('computes BMR for female: 10w + 6.25h - 5a - 161', () => {
    const female = { ...baseProfile, sex: 'female' as const };
    const expected = 10 * 80 + 6.25 * 180 - 5 * 25 - 161;
    expect(estimateBmrKcal(female)).toBeCloseTo(expected, 1);
  });

  it('clamps extreme weight (< 30 or > 250)', () => {
    const light = estimateBmrKcal({ ...baseProfile, weightKg: 10 });
    const normal30 = estimateBmrKcal({ ...baseProfile, weightKg: 30 });
    expect(light).toBe(normal30); // clamped to 30

    const heavy = estimateBmrKcal({ ...baseProfile, weightKg: 300 });
    const normal250 = estimateBmrKcal({ ...baseProfile, weightKg: 250 });
    expect(heavy).toBe(normal250); // clamped to 250
  });

  it('clamps extreme height', () => {
    const short = estimateBmrKcal({ ...baseProfile, heightCm: 50 });
    const min120 = estimateBmrKcal({ ...baseProfile, heightCm: 120 });
    expect(short).toBe(min120);
  });

  it('clamps extreme age', () => {
    const baby = estimateBmrKcal({ ...baseProfile, ageYears: 5 });
    const age12 = estimateBmrKcal({ ...baseProfile, ageYears: 12 });
    expect(baby).toBe(age12);
  });

  it('clampInt returns min for non-finite age (covers user/nutrition.ts line 4)', () => {
    // clampInt(Infinity, 12, 90) → !isFinite → returns 12
    const resultInf = estimateBmrKcal({ ...baseProfile, ageYears: Infinity });
    const resultMin = estimateBmrKcal({ ...baseProfile, ageYears: 12 });
    expect(resultInf).toBe(resultMin);
  });
});

describe('estimateTdeeKcal', () => {
  it('equals BMR * activity multiplier', () => {
    const bmr = estimateBmrKcal(baseProfile);
    const mult = activityMultiplier('moderate');
    expect(estimateTdeeKcal(baseProfile)).toBeCloseTo(bmr * mult, 1);
  });

  it('returns higher value for active lifestyle', () => {
    const activeProfile = { ...baseProfile, activity: 'active' as const };
    expect(estimateTdeeKcal(activeProfile)).toBeGreaterThan(estimateTdeeKcal(baseProfile));
  });
});

describe('goalDeltaKcal', () => {
  it('returns -400 for lose_fat', () => {
    expect(goalDeltaKcal('lose_fat')).toBe(-400);
  });

  it('returns +250 for gain_muscle', () => {
    expect(goalDeltaKcal('gain_muscle')).toBe(250);
  });

  it('returns -150 for recomp', () => {
    expect(goalDeltaKcal('recomp')).toBe(-150);
  });

  it('returns 0 for performance and unknown', () => {
    expect(goalDeltaKcal('performance')).toBe(0);
    expect(goalDeltaKcal('unknown' as any)).toBe(0);
  });
});

describe('estimateTargetCaloriesKcal', () => {
  it('rounds to integer', () => {
    const result = estimateTargetCaloriesKcal(baseProfile);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('is lower for fat loss goal', () => {
    const fat = estimateTargetCaloriesKcal({ ...baseProfile, goal: 'lose_fat' });
    const perf = estimateTargetCaloriesKcal({ ...baseProfile, goal: 'performance' });
    expect(fat).toBe(perf - 400);
  });

  it('is higher for muscle gain goal', () => {
    const muscle = estimateTargetCaloriesKcal({ ...baseProfile, goal: 'gain_muscle' });
    const perf = estimateTargetCaloriesKcal({ ...baseProfile, goal: 'performance' });
    expect(muscle).toBe(perf + 250);
  });
});
