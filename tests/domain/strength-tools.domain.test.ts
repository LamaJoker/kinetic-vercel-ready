import { describe, it, expect } from 'vitest';
import {
  estimateOneRm,
  roundToPlates,
  percentTable,
  rpeTable,
  rpePercent,
  loadForRpe,
  knownE1rmByExercise,
  RPE_TABLE_RPES,
} from '@kinetic/core';

describe('estimateOneRm', () => {
  it('donne les valeurs de référence pour 100 kg × 5', () => {
    const r = estimateOneRm(100, 5)!;
    expect(r.epley).toBe(116.7); // 100 × (1 + 5/30)
    expect(r.brzycki).toBe(112.5); // 100 × 36 / 32
    expect(r.lombardi).toBe(117.5); // 100 × 5^0,1
    expect(r.average).toBe(115.5);
    expect(r.reliable).toBe(true);
  });

  it('vaut la charge elle-même pour une seule répétition', () => {
    const r = estimateOneRm(140, 1)!;
    expect([r.epley, r.brzycki, r.lombardi, r.average]).toEqual([140, 140, 140, 140]);
  });

  it('Epley et Brzycki se rejoignent à 10 reps', () => {
    const r = estimateOneRm(100, 10)!;
    expect(r.epley).toBe(133.3);
    expect(r.brzycki).toBe(133.3);
    expect(r.lombardi).toBe(125.9);
  });

  it('signale une estimation peu fiable au-delà de 10 reps', () => {
    expect(estimateOneRm(60, 12)!.reliable).toBe(false);
  });

  it('refuse une saisie vide ou hors bornes', () => {
    expect(estimateOneRm(0, 5)).toBeNull();
    expect(estimateOneRm(100, 0)).toBeNull();
    expect(estimateOneRm(100, 21)).toBeNull();
    expect(estimateOneRm(Number.NaN, 5)).toBeNull();
  });
});

describe('roundToPlates', () => {
  it('arrondit au plus près avec le jeu standard (pas de 1 kg)', () => {
    const r = roundToPlates(101.4, { barKg: 20 });
    expect(r.kg).toBe(101);
    expect(r.perSide).toBe('25×1, 15×1, 0.5×1');
  });

  it('respecte les disques disponibles (pas de 2,5 kg)', () => {
    const r = roundToPlates(101, { barKg: 20, plates: [20, 10, 5, 2.5, 1.25] });
    expect(r.kg).toBe(100);
    expect(r.perSide).toBe('20×2');
    expect(roundToPlates(101.3, { barKg: 20, plates: [20, 10, 5, 2.5, 1.25] }).kg).toBe(102.5);
  });

  it('arrondit au pas de l’exercice hors barre (haltères)', () => {
    expect(roundToPlates(21.6, { barKg: 20, incrementKg: 2 })).toEqual({ kg: 22, perSide: '' });
    expect(roundToPlates(13.4, { barKg: 20, incrementKg: 1.25 }).kg).toBe(13.75);
  });

  it('ne descend jamais sous la barre', () => {
    expect(roundToPlates(10, { barKg: 20 })).toEqual({ kg: 20, perSide: 'barre seule' });
  });
});

describe('percentTable', () => {
  it('va de 100 % à 50 % par pas de 5, arrondie aux disques', () => {
    const rows = percentTable(137, { barKg: 20, plates: [25, 20, 15, 10, 5, 2.5, 1.25] });
    expect(rows.map((r) => r.pct)).toEqual([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50]);
    expect(rows[0]!.exactKg).toBe(137);
    expect(rows[0]!.load.kg).toBe(137.5);
    const r55 = rows.find((r) => r.pct === 55)!;
    expect(r55.exactKg).toBe(75.4);
    expect(r55.load.kg).toBe(75);
  });

  it('est vide sans max', () => {
    expect(percentTable(0, { barKg: 20 })).toEqual([]);
  });
});

describe('table RPE (RTS / Tuchscherer)', () => {
  it('reprend les valeurs classiques', () => {
    expect(rpePercent(1, 10)).toBe(100);
    expect(rpePercent(1, 9)).toBe(95.5);
    expect(rpePercent(3, 9)).toBe(89.2);
    expect(rpePercent(5, 8)).toBe(81.1);
    expect(rpePercent(8, 8)).toBe(73.9);
    expect(rpePercent(1, 9.5)).toBe(97.8);
  });

  it('a 12 lignes et une colonne par RPE, décroissantes', () => {
    const t = rpeTable();
    expect(t).toHaveLength(12);
    for (const row of t) {
      expect(row.pcts).toHaveLength(RPE_TABLE_RPES.length);
      for (let i = 1; i < row.pcts.length; i++) expect(row.pcts[i]!).toBeLessThan(row.pcts[i - 1]!);
    }
  });

  it('calcule la charge pour X reps à RPE Y', () => {
    const r = loadForRpe(200, 5, 8, { barKg: 20 })!;
    expect(r.pct).toBe(81.1);
    expect(r.exactKg).toBe(162.2);
    expect(r.load.kg).toBe(162);
    expect(loadForRpe(0, 5, 8, { barKg: 20 })).toBeNull();
  });
});

describe('knownE1rmByExercise', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  it('préfère le meilleur récent, sinon le meilleur de tout l’historique', () => {
    const m = knownE1rmByExercise(
      [
        { exerciseId: 'bp', weightKg: 120, reps: 3, performedAt: '2026-01-10T10:00:00Z' },
        { exerciseId: 'bp', weightKg: 100, reps: 5, performedAt: '2026-11-10T10:00:00Z' },
        { exerciseId: 'sq', weightKg: 140, reps: 5, performedAt: '2026-02-01T10:00:00Z' },
        { exerciseId: 'plank', weightKg: 0, reps: 0, performedAt: '2026-11-10T10:00:00Z' },
      ],
      now,
    );
    expect(m.get('bp')).toBe(116.7);
    expect(m.get('sq')).toBe(163.3);
    expect(m.has('plank')).toBe(false);
  });
});
