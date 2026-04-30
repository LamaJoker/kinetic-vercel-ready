import { describe, it, expect } from 'vitest';
import {
  suggestProgression,
  needsDeload,
  e1rm,
  slope,
  type PerformedSet,
} from '@kinetic/core';

/**
 * Crée un PerformedSet avec une date relative à maintenant.
 * dayOffset négatif = N jours dans le passé.
 * Par défaut les sets sont récents (dans la fenêtre de 14j utilisée par deload).
 */
function set(reps: number, weightKg: number, rpe: number, dayOffset = 0): PerformedSet {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return { reps, weightKg, rpe, at: d.toISOString() };
}

describe('e1rm (Epley)', () => {
  it('retourne le poids soulevé pour 1 rep', () => {
    expect(e1rm(100, 1)).toBeCloseTo(100 * (1 + 1 / 30));
  });

  it('est croissant avec les reps', () => {
    expect(e1rm(100, 8)).toBeGreaterThan(e1rm(100, 5));
  });
});

describe('slope', () => {
  it('retourne 0 pour moins de 2 points', () => {
    expect(slope([])).toBe(0);
    expect(slope([42])).toBe(0);
  });

  it('est positif pour une série croissante', () => {
    expect(slope([1, 2, 3, 4])).toBeGreaterThan(0);
  });

  it('est négatif pour une série décroissante', () => {
    expect(slope([4, 3, 2, 1])).toBeLessThan(0);
  });

  it('est nul pour une série plate', () => {
    expect(slope([5, 5, 5, 5])).toBe(0);
  });
});

describe('suggestProgression', () => {
  const base = { exerciseId: 'squat', targetReps: 8, targetRpe: 8, incrementKg: 2.5 };

  it('retourne first_time sans historique', () => {
    const s = suggestProgression({ ...base, history: [] });
    expect(s.strategy).toBe('first_time');
    expect(s.confidence).toBeLessThan(0.5);
  });

  it('augmente la charge si RPE trop bas et reps atteintes', () => {
    const history = [set(8, 100, 7, 0)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('increase_weight');
    expect(s.suggestedWeight).toBe(102.5);
  });

  it('augmente les reps si RPE proche de la cible mais reps pas atteintes', () => {
    const history = [set(7, 100, 8, 0)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('increase_reps');
    expect(s.suggestedWeight).toBe(100);
    expect(s.suggestedReps).toBe(8);
  });

  it('maintient si RPE trop haut (>target+0.5)', () => {
    const history = [set(6, 100, 9.5, 0)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('hold');
    expect(s.suggestedWeight).toBe(100);
  });

  it('déclenche un deload après 3 séances saturées sans progrès d’e1RM', () => {
    const history = [
      set(6, 100, 9.5, -6),
      set(6, 100, 9.5, -3),
      set(6, 100, 10,  0),
    ];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('deload');
    expect(s.suggestedWeight).toBe(90);             // -10%, arrondi à l’incrément
    expect(s.suggestedRpe).toBeLessThanOrEqual(6.5); // allègement du RPE cible
  });

  it('respecte l’increment fourni (machine avec pas de 5)', () => {
    const history = [set(10, 70, 7, 0)];
    const s = suggestProgression({ ...base, incrementKg: 5, history });
    expect(s.strategy).toBe('increase_weight');
    expect(s.suggestedWeight).toBe(75);
  });
});

describe('needsDeload', () => {
  it('retourne false avec moins de 5 séances', () => {
    expect(needsDeload([set(8, 100, 9, 0)])).toBe(false);
  });

  it('retourne true sur 5 séances RPE >= 9 avec e1RM plat', () => {
    const h = [
      set(8, 100, 9,   -8),
      set(8, 100, 9.5, -6),
      set(8, 100, 9.5, -4),
      set(8, 100, 9,   -2),
      set(8, 100, 9.5,  0),
    ];
    expect(needsDeload(h)).toBe(true);
  });

  it('retourne false si l’e1RM monte malgré un RPE élevé', () => {
    const h = [
      set(8,  90, 9, -8),
      set(8,  95, 9, -6),
      set(8, 100, 9, -4),
      set(8, 105, 9, -2),
      set(8, 110, 9,  0),
    ];
    expect(needsDeload(h)).toBe(false);
  });
});
