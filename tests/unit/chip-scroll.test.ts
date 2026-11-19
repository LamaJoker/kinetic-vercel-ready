import { describe, it, expect } from 'vitest';
import {
  chipFades,
  chipScrollTarget,
  CHIP_SCROLL_MARGIN,
} from '../../apps/web/src/lib/chip-scroll.js';

describe('chipScrollTarget', () => {
  // Rangée de 390 px de large, contenu de 700 px.
  it('ne bouge pas si le choix est déjà visible', () => {
    expect(chipScrollTarget(390, 700, 0, 100, 80)).toBe(0);
    expect(chipScrollTarget(390, 700, 120, 200, 80)).toBe(120);
  });

  it('amène un choix caché à droite avec une marge', () => {
    // fin du choix = 600 → 600 + marge - 390
    expect(chipScrollTarget(390, 700, 0, 520, 80)).toBe(600 + CHIP_SCROLL_MARGIN - 390);
  });

  it('amène un choix caché à gauche avec une marge, borné à 0', () => {
    expect(chipScrollTarget(390, 700, 300, 200, 80)).toBe(200 - CHIP_SCROLL_MARGIN);
    expect(chipScrollTarget(390, 700, 300, 10, 80)).toBe(0);
  });

  it('ne dépasse jamais la fin du contenu', () => {
    expect(chipScrollTarget(390, 700, 0, 640, 60)).toBe(310);
    expect(chipScrollTarget(390, 300, 0, 250, 40)).toBe(0); // contenu plus court
  });
});

describe('chipFades', () => {
  it('fondu à droite au début, des deux côtés au milieu, à gauche à la fin', () => {
    expect(chipFades(390, 700, 0)).toEqual({ start: false, end: true });
    expect(chipFades(390, 700, 150)).toEqual({ start: true, end: true });
    expect(chipFades(390, 700, 310)).toEqual({ start: true, end: false });
    expect(chipFades(390, 390, 0)).toEqual({ start: false, end: false });
  });
});
