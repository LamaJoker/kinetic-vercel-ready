import { describe, it, expect } from 'vitest';
import { suggestProgression, needsDeload, e1rm, slope, type PerformedSet } from '@kinetic/core';

/**
 * Cree un PerformedSet avec une date relative a maintenant.
 * dayOffset negatif = N jours dans le passe.
 * Par defaut les sets sont recents (dans la fenetre de 14j utilisee par deload).
 */
function set(reps: number, weightKg: number, rpe: number, dayOffset = 0): PerformedSet {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return { reps, weightKg, rpe, at: d.toISOString() };
}

describe('e1rm (Epley)', () => {
  it('retourne le poids souleve pour 1 rep', () => {
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

  it('est positif pour une serie croissante', () => {
    expect(slope([1, 2, 3, 4])).toBeGreaterThan(0);
  });

  it('est negatif pour une serie decroissante', () => {
    expect(slope([4, 3, 2, 1])).toBeLessThan(0);
  });

  it('est nul pour une serie plate', () => {
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

  it("declenche un deload apres 3 seances saturees sans progres d'e1RM", () => {
    const history = [set(6, 100, 9.5, -6), set(6, 100, 9.5, -3), set(6, 100, 10, 0)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('deload');
    expect(s.suggestedWeight).toBe(90); // -10%, arrondi a l'increment
    expect(s.suggestedRpe).toBeLessThanOrEqual(6.5);
  });

  it("respecte l'increment fourni (machine avec pas de 5)", () => {
    const history = [set(10, 70, 7, 0)];
    const s = suggestProgression({ ...base, incrementKg: 5, history });
    expect(s.strategy).toBe('increase_weight');
    expect(s.suggestedWeight).toBe(75);
  });

  it('retourne hold quand RPE proche de la cible ET reps deja atteintes', () => {
    // RPE=8.3 -> |8.3-8| = 0.3 <= 0.5, mais reps=8 >= targetReps=8 -> fallback hold
    const history = [set(8, 100, 8.3, 0)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).toBe('hold');
    expect(s.suggestedWeight).toBe(100);
  });

  it('utilise 2.5 kg comme increment par defaut quand incrementKg vaut 0 (couvre roundTo step<=0)', () => {
    const history = [set(10, 70, 7, 0)];
    const s = suggestProgression({ ...base, incrementKg: 0, history });
    expect(s.strategy).toBe('increase_weight');
    // roundTo(70 + 0, 0) → step = 2.5 → Math.round(70/2.5)*2.5 = 28*2.5 = 70
    expect(s.suggestedWeight).toBe(70);
  });

  it('ne declenche pas de deload si les sets sont hors de la fenetre 14j', () => {
    // 3 sets satures mais > 14 jours dans le passe -> pas dans recentSets
    const history = [set(6, 100, 9.5, -20), set(6, 100, 9.5, -18), set(6, 100, 10, -16)];
    const s = suggestProgression({ ...base, history });
    expect(s.strategy).not.toBe('deload');
  });
});

describe('needsDeload', () => {
  it('retourne false avec moins de 5 seances', () => {
    expect(needsDeload([set(8, 100, 9, 0)])).toBe(false);
  });

  it('retourne true sur 5 seances RPE >= 9 avec e1RM plat', () => {
    const h = [
      set(8, 100, 9, -8),
      set(8, 100, 9.5, -6),
      set(8, 100, 9.5, -4),
      set(8, 100, 9, -2),
      set(8, 100, 9.5, 0),
    ];
    expect(needsDeload(h)).toBe(true);
  });

  it("retourne false si l'e1RM monte malgre un RPE eleve", () => {
    const h = [
      set(8, 90, 9, -8),
      set(8, 95, 9, -6),
      set(8, 100, 9, -4),
      set(8, 105, 9, -2),
      set(8, 110, 9, 0),
    ];
    expect(needsDeload(h)).toBe(false);
  });
});
