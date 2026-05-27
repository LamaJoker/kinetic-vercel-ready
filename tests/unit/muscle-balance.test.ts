import { describe, it, expect } from 'vitest';
import {
  classifyPattern,
  muscleBalance,
  type BalanceSet,
} from '../../packages/core/src/domain/muscle-balance.domain.js';

describe('classifyPattern', () => {
  it('classifies push correctly', () => {
    expect(classifyPattern(['chest', 'triceps'])).toBe('push');
    expect(classifyPattern(['shoulders', 'triceps'])).toBe('push');
  });

  it('classifies pull correctly', () => {
    expect(classifyPattern(['back', 'biceps'])).toBe('pull');
    expect(classifyPattern(['upper_back'])).toBe('pull');
  });

  it('classifies legs correctly', () => {
    expect(classifyPattern(['quads'])).toBe('legs');
    expect(classifyPattern(['hamstrings', 'glutes'])).toBe('legs');
  });

  it('returns other when no major group matches', () => {
    expect(classifyPattern(['core'])).toBe('other');
    expect(classifyPattern([])).toBe('other');
  });
});

function setAt(daysAgo: number, muscles: string[], now: Date = new Date()): BalanceSet {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return { muscles, performedAt: d.toISOString() };
}

describe('muscleBalance', () => {
  const now = new Date('2026-01-15T10:00:00Z');

  it('returns unreliable when total sets < threshold', () => {
    const sets = [setAt(1, ['chest'], now), setAt(2, ['back'], now)];
    const report = muscleBalance(sets, 4, now);
    expect(report.reliable).toBe(false);
    expect(report.underWorked).toBeNull();
    expect(report.overWorked).toBeNull();
  });

  it('flags underWorked when one pattern is half the median of others', () => {
    // 12 push, 12 legs, 1 pull → pull est sous-travaillé
    const sets: BalanceSet[] = [
      ...Array.from({ length: 12 }, () => setAt(2, ['chest'], now)),
      ...Array.from({ length: 12 }, () => setAt(2, ['quads'], now)),
      setAt(1, ['back'], now),
    ];
    const report = muscleBalance(sets, 4, now);
    expect(report.reliable).toBe(true);
    expect(report.underWorked).toBe('pull');
  });

  it('flags overWorked when one pattern dwarfs the others', () => {
    // 20 push, 5 pull, 5 legs → push est sur-travaillé
    const sets: BalanceSet[] = [
      ...Array.from({ length: 20 }, () => setAt(3, ['chest'], now)),
      ...Array.from({ length: 5 }, () => setAt(3, ['back'], now)),
      ...Array.from({ length: 5 }, () => setAt(3, ['quads'], now)),
    ];
    const report = muscleBalance(sets, 4, now);
    expect(report.reliable).toBe(true);
    expect(report.overWorked).toBe('push');
  });

  it('ignores sets outside the time window', () => {
    const sets: BalanceSet[] = [
      ...Array.from({ length: 20 }, () => setAt(100, ['chest'], now)), // hors fenêtre (4 sem)
    ];
    const report = muscleBalance(sets, 4, now);
    expect(report.total).toBe(0);
  });

  it('returns balanced report when distribution is even', () => {
    const sets: BalanceSet[] = [
      ...Array.from({ length: 10 }, () => setAt(2, ['chest'], now)),
      ...Array.from({ length: 10 }, () => setAt(2, ['back'], now)),
      ...Array.from({ length: 10 }, () => setAt(2, ['quads'], now)),
    ];
    const report = muscleBalance(sets, 4, now);
    expect(report.reliable).toBe(true);
    expect(report.underWorked).toBeNull();
    expect(report.overWorked).toBeNull();
  });
});
