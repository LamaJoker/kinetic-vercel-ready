import { describe, it, expect, vi } from 'vitest';
import { createDerivedCache, localDayKey } from '../../apps/web/src/lib/derived-cache';
import { rawOf } from '../../apps/web/src/lib/reactive-raw';

describe('createDerivedCache', () => {
  it('calcule une fois tant que les dépendances (identité) ne changent pas', () => {
    const cache = createDerivedCache();
    const list = [1, 2, 3];
    const compute = vi.fn(() => list.reduce((a, b) => a + b, 0));
    expect(cache.get('sum', [list], compute)).toBe(6);
    expect(cache.get('sum', [list], compute)).toBe(6);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('recalcule pour un nouveau tableau, même de contenu égal, ou un autre jour', () => {
    const cache = createDerivedCache();
    const compute = vi.fn((n: number) => n);
    cache.get('x', [[1], '2026-11-25'], () => compute(1));
    cache.get('x', [[1], '2026-11-25'], () => compute(2));
    expect(compute).toHaveBeenCalledTimes(2);
    const same = [1];
    cache.get('y', [same, '2026-11-25'], () => compute(3));
    cache.get('y', [same, '2026-11-26'], () => compute(4));
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it('valeurs indépendantes par nom, clear() oublie tout', () => {
    const cache = createDerivedCache();
    const deps = [{}];
    expect(cache.get('a', deps, () => 'A')).toBe('A');
    expect(cache.get('b', deps, () => 'B')).toBe('B');
    expect(cache.get('a', deps, () => 'autre')).toBe('A');
    cache.clear();
    expect(cache.get('a', deps, () => 'nouveau')).toBe('nouveau');
  });

  it('localDayKey : date locale AAAA-MM-JJ', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('rawOf : valeur inchangée sans Alpine (Node), Alpine.raw sinon', () => {
    const v = { a: 1 };
    expect(rawOf(v)).toBe(v);
    const raw = { a: 2 };
    vi.stubGlobal('window', { Alpine: { raw: () => raw } });
    expect(rawOf(v)).toBe(raw);
    vi.unstubAllGlobals();
  });
});
