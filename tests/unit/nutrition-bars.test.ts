import { describe, it, expect } from 'vitest';
import { buildMacroBars, ringDash } from '../../apps/web/src/stores/nutrition.js';

const targets = { proteinG: 170, carbsG: 282, fatG: 78 };

describe('barres de macros', () => {
  it('calcule la progression et la largeur de chaque barre', () => {
    const [p, c, f] = buildMacroBars({ proteinG: 85, carbsG: 141, fatG: 0 }, targets);
    expect(p).toMatchObject({ label: 'Protéines', pct: 50, over: false, detail: '85 / 170 g' });
    expect(p!.style.width).toBe('50%');
    expect(c!.pct).toBe(50);
    expect(f!.style.width).toBe('0%');
  });

  it('plafonne à 100 % et signale le dépassement', () => {
    const [p] = buildMacroBars({ proteinG: 200, carbsG: 0, fatG: 0 }, targets);
    expect(p!.pct).toBe(100);
    expect(p!.over).toBe(true);
    expect(p!.detail).toBe('Dépassé de 30 g');
  });

  it('rend visible une toute petite quantité', () => {
    const [p] = buildMacroBars({ proteinG: 1, carbsG: 0, fatG: 0 }, targets);
    expect(p!.style.width).toBe('2%');
  });

  it('sans plan : barres vides, sans division par zéro', () => {
    const bars = buildMacroBars({ proteinG: 50, carbsG: 50, fatG: 50 }, null);
    expect(bars.every((b) => b.pct === 0 && !b.over)).toBe(true);
  });
});

describe('anneau des calories', () => {
  it('remplit proportionnellement et plafonne', () => {
    expect(ringDash(1254, 2508, 188)).toBe('94.0 188');
    expect(ringDash(5000, 2508, 188)).toBe('188.0 188');
    expect(ringDash(100, 0, 188)).toBe('0.0 188');
  });
});
