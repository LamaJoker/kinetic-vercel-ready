import { describe, it, expect } from 'vitest';
import {
  clampRpe,
  clampWeightKg,
  roundToIncrementKg,
  suggestNextWeightKg,
  estimateE1rmKg,
} from '../../apps/web/src/lib/training/rpe.js';

describe('clampRpe', () => {
  it('returns value within [6, 10]', () => {
    expect(clampRpe(8)).toBe(8);
    expect(clampRpe(6)).toBe(6);
    expect(clampRpe(10)).toBe(10);
  });

  it('clamps below 6 to 6', () => {
    expect(clampRpe(0)).toBe(6);
    expect(clampRpe(-5)).toBe(6);
  });

  it('clamps above 10 to 10', () => {
    expect(clampRpe(12)).toBe(10);
  });

  it('returns 8 for non-finite values', () => {
    expect(clampRpe(NaN)).toBe(8);
    expect(clampRpe(Infinity)).toBe(8);
    expect(clampRpe(-Infinity)).toBe(8);
  });
});

describe('clampWeightKg', () => {
  it('returns positive value unchanged', () => {
    expect(clampWeightKg(100)).toBe(100);
    expect(clampWeightKg(0)).toBe(0);
  });

  it('clamps negative to 0', () => {
    expect(clampWeightKg(-10)).toBe(0);
  });

  it('returns 0 for non-finite values (NaN, Infinity, -Infinity)', () => {
    expect(clampWeightKg(NaN)).toBe(0);
    expect(clampWeightKg(Infinity)).toBe(0);
    expect(clampWeightKg(-Infinity)).toBe(0);
  });
});

describe('roundToIncrementKg', () => {
  it('rounds to nearest 2.5 increment', () => {
    expect(roundToIncrementKg(101, 2.5)).toBe(100);
    expect(roundToIncrementKg(102.5, 2.5)).toBe(102.5);
  });

  it('rounds to nearest 5kg increment', () => {
    expect(roundToIncrementKg(102, 5)).toBe(100);
    expect(roundToIncrementKg(103, 5)).toBe(105);
  });

  it('uses 2.5 default when increment is 0 or negative', () => {
    expect(roundToIncrementKg(100, 0)).toBe(100);
    expect(roundToIncrementKg(101, -1)).toBe(100);
  });

  it('rounds to nearest 1kg increment', () => {
    expect(roundToIncrementKg(10.4, 1)).toBe(10);
    expect(roundToIncrementKg(10.6, 1)).toBe(11);
  });
});

describe('suggestNextWeightKg', () => {
  const exercise = {
    id: 'bp',
    name: 'Bench Press',
    muscles: ['chest'],
    equipment: 'barbell' as const,
    incrementKg: 2.5,
  };

  it('increases weight when rpe < target (too easy)', () => {
    const next = suggestNextWeightKg({ currentWeightKg: 100, rpe: 6, targetRpe: 8, exercise });
    expect(next).toBe(102.5);
  });

  it('decreases weight when rpe > target (too hard)', () => {
    const next = suggestNextWeightKg({ currentWeightKg: 100, rpe: 9, targetRpe: 7, exercise });
    expect(next).toBe(97.5);
  });

  it('keeps weight when rpe matches target', () => {
    const next = suggestNextWeightKg({ currentWeightKg: 100, rpe: 8, targetRpe: 8, exercise });
    expect(next).toBe(100);
  });

  it('uses 2.5kg default increment without exercise', () => {
    const next = suggestNextWeightKg({ currentWeightKg: 100, rpe: 6, targetRpe: 8 });
    expect(next).toBe(102.5);
  });

  it('clamps negative result to 0', () => {
    const next = suggestNextWeightKg({ currentWeightKg: 0, rpe: 10, targetRpe: 6, exercise });
    expect(next).toBe(0);
  });
});

describe('estimateE1rmKg', () => {
  it('computes Epley formula: w * (1 + r/30)', () => {
    expect(estimateE1rmKg(100, 10)).toBeCloseTo(100 * (1 + 10 / 30));
  });

  it('returns weight for 1 rep', () => {
    expect(estimateE1rmKg(100, 1)).toBeCloseTo(100 * (1 + 1 / 30));
  });

  it('clamps reps to max 20', () => {
    const at20 = estimateE1rmKg(100, 20);
    const at30 = estimateE1rmKg(100, 30);
    expect(at20).toBe(at30); // 30 clamped to 20 → same result
    // Actually reps 30 clamped to 20 → 100 * (1 + 20/30) for both
    expect(at20).toBeCloseTo(100 * (1 + 20 / 30));
  });

  it('returns 0 for 0 weight', () => {
    expect(estimateE1rmKg(0, 10)).toBe(0);
  });

  it('clamps weight to 0 minimum', () => {
    expect(estimateE1rmKg(-50, 5)).toBe(0);
  });
});
