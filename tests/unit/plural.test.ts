import { describe, it, expect } from 'vitest';
import { plural, pluralWord } from '../../apps/web/src/lib/plural.js';

describe('plural', () => {
  it('singulier pour 0 et 1, pluriel à partir de 2', () => {
    expect(plural(0, 'séance')).toBe('0 séance');
    expect(plural(1, 'séance')).toBe('1 séance');
    expect(plural(3, 'séance')).toBe('3 séances');
  });
  it('pluriel irrégulier et mot seul', () => {
    expect(plural(2, 'série complétée', 'séries complétées')).toBe('2 séries complétées');
    expect(pluralWord(5, 'jour')).toBe('jours');
    expect(plural(Number.NaN, 'photo')).toBe('0 photo');
  });
});
