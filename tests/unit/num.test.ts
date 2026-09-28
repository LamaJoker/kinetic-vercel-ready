import { describe, it, expect } from 'vitest';
import { num } from '../../apps/web/src/lib/num.js';

describe('$num', () => {
  it('arrondit, borne et calcule des pourcentages sûrs', () => {
    expect(num.round(2.345, 1)).toBe(2.3);
    expect(num.round(Number.NaN)).toBe(0);
    expect(num.min(100, 140)).toBe(100);
    expect(num.abs(-2.4)).toBe(2.4);
    expect(num.pct(3, 8)).toBe(38);
    expect(num.pct(12, 8)).toBe(100);
    expect(num.pct(1, 0)).toBe(0);
  });
});
