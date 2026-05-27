import { describe, it, expect } from 'vitest';
import {
  calculatePlates,
  formatPlateLoad,
  DEFAULT_PLATES_METRIC,
} from '../../packages/core/src/domain/plate-calculator.domain.js';

describe('calculatePlates', () => {
  it('charges 100 kg avec une barre 20 kg', () => {
    const r = calculatePlates({ targetKg: 100, barKg: 20 });
    // (100 - 20) / 2 = 40 kg par côté → 20+15+5 ou 20+10+5+2.5+2.5… Le glouton prend 20+15+5
    expect(r.underBar).toBe(false);
    expect(r.inexact).toBe(false);
    expect(r.achievedKg).toBe(100);
    const perSideKg = r.perSide.reduce((s, p) => s + p.plateKg * p.count, 0);
    expect(perSideKg).toBe(40);
  });

  it('charge 142.5 kg avec une barre 20 kg', () => {
    const r = calculatePlates({ targetKg: 142.5, barKg: 20 });
    expect(r.achievedKg).toBe(142.5);
    expect(r.inexact).toBe(false);
  });

  it('signale "underBar" quand cible < barre', () => {
    const r = calculatePlates({ targetKg: 15, barKg: 20 });
    expect(r.underBar).toBe(true);
    expect(r.perSide).toHaveLength(0);
  });

  it('retourne barre seule quand cible = barre', () => {
    const r = calculatePlates({ targetKg: 20, barKg: 20 });
    expect(r.perSide).toHaveLength(0);
    expect(r.achievedKg).toBe(20);
    expect(r.inexact).toBe(false);
  });

  it('marque "inexact" si la cible ne tombe pas pile', () => {
    // 102.7 kg → 41.35 kg par côté → glouton charge 40 kg (20+15+5), il reste 1.35
    const r = calculatePlates({ targetKg: 102.7, barKg: 20 });
    expect(r.inexact).toBe(true);
    expect(r.deltaKg).toBeGreaterThan(0);
  });

  it('utilise les plates fournies si spécifiées', () => {
    // Salle pauvre : seulement des 20 et 5 → 110 kg = (20+20+5) par côté + barre 20
    const r = calculatePlates({ targetKg: 110, barKg: 20, availablePlates: [20, 5] });
    expect(r.perSide).toHaveLength(2);
    expect(r.perSide[0]).toEqual({ plateKg: 20, count: 2 });
    expect(r.perSide[1]).toEqual({ plateKg: 5, count: 1 });
    expect(r.achievedKg).toBe(110);
  });

  it('omet les plates à count=0 dans la sortie', () => {
    const r = calculatePlates({ targetKg: 100, barKg: 20, availablePlates: [20, 5] });
    // 40 par côté = 2× 20 — pas besoin de 5
    expect(r.perSide).toHaveLength(1);
    expect(r.perSide[0]).toEqual({ plateKg: 20, count: 2 });
  });

  it('rejette les inputs négatifs / NaN', () => {
    const r = calculatePlates({ targetKg: NaN, barKg: 20 });
    expect(r.underBar).toBe(true);
  });

  it('DEFAULT_PLATES_METRIC est triée décroissante', () => {
    for (let i = 1; i < DEFAULT_PLATES_METRIC.length; i++) {
      expect(DEFAULT_PLATES_METRIC[i - 1]!).toBeGreaterThan(DEFAULT_PLATES_METRIC[i]!);
    }
  });
});

describe('formatPlateLoad', () => {
  it('formate "20×2, 5×1"', () => {
    expect(
      formatPlateLoad([
        { plateKg: 20, count: 2 },
        { plateKg: 5, count: 1 },
      ]),
    ).toBe('20×2, 5×1');
  });

  it('renvoie "barre seule" si vide', () => {
    expect(formatPlateLoad([])).toBe('barre seule');
  });
});
