import { describe, it, expect } from 'vitest';
import { achievements } from '../../apps/web/src/pages/achievements.page.js';
import type { Achievement } from '@kinetic/core';

function make(unlocked: string[], progressPercent?: number) {
  const page = achievements();
  page.$store = {
    achievements: {
      catalog: [] as Achievement[],
      isUnlocked: (id: string) => unlocked.includes(id),
      progressPercent,
    },
  };
  return page;
}

describe('achievements page — présentation', () => {
  it('ringStyle expose le pourcentage, borné entre 0 et 100', () => {
    expect(make([], 49).ringStyle).toBe('--p: 49');
    expect(make([], 140).ringStyle).toBe('--p: 100');
    expect(make([], -3).ringStyle).toBe('--p: 0');
    expect(make([]).ringStyle).toBe('--p: 0');
  });

  it('medalClass : or pour un succès débloqué, gris sinon', () => {
    const page = make(['a']);
    expect(page.medalClass('a')).toContain('radial-gradient');
    expect(page.medalClass('b')).toBe('bg-kinetic-elevated');
  });

  it('tierDotClass : points pleins jusqu’au niveau, estompés au-delà', () => {
    const page = make(['a']);
    expect(page.tierDotClass('a', 2, 3)).toBe('bg-kinetic-gold');
    expect(page.tierDotClass('b', 2, 3)).toBe('bg-gray-400');
    expect(page.tierDotClass('a', 4, 3)).toBe('bg-gray-400 opacity-25');
  });
});

describe('achievements page — creux de médaille', () => {
  it('medalWellClass : creux sombre pour un succès débloqué', () => {
    const page = make(['a']);
    expect(page.medalWellClass('a')).toContain('radial-gradient');
    expect(page.medalWellClass('b')).toBe('ring-white/10');
  });
});
