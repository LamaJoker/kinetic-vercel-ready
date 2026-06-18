import { describe, it, expect } from 'vitest';
import { percentOf1RM, estimatedE1rmFromRpe, loadForReps, pickTopSet } from '@kinetic/core';

describe('percentOf1RM', () => {
  it('vaut 100 % pour 1 rep @ RPE 10 (1RM réel)', () => {
    expect(percentOf1RM(1, 10)).toBeCloseTo(1.0);
  });

  it('correspond à la charte RTS (8 reps @ RPE 8 ≈ 10 reps effectives ≈ 73.9 %)', () => {
    expect(percentOf1RM(8, 8)).toBeCloseTo(0.739, 3);
  });

  it('correspond à la charte RTS (5 reps @ RPE 8 ≈ 7 reps effectives ≈ 81.1 %)', () => {
    expect(percentOf1RM(5, 8)).toBeCloseTo(0.811, 3);
  });

  it('décroît quand la RPE baisse (charge plus facile = moins de %1RM)', () => {
    expect(percentOf1RM(8, 7)).toBeLessThan(percentOf1RM(8, 9));
  });

  it('décroît quand les reps augmentent à RPE égale', () => {
    expect(percentOf1RM(10, 8)).toBeLessThan(percentOf1RM(5, 8));
  });

  it('interpole les demi-RPE', () => {
    const mid = percentOf1RM(8, 8.5);
    expect(mid).toBeGreaterThan(percentOf1RM(8, 8));
    expect(mid).toBeLessThan(percentOf1RM(8, 9));
  });

  it('clamp la RPE au-dessus de 10 et en dessous de 6', () => {
    expect(percentOf1RM(5, 12)).toBeCloseTo(percentOf1RM(5, 10));
    expect(percentOf1RM(5, 3)).toBeCloseTo(percentOf1RM(5, 6));
  });

  it('reste défini et plancher en très haute rep', () => {
    const p = percentOf1RM(40, 6); // 40 + 4 RIR = 44 reps effectives
    expect(p).toBeGreaterThanOrEqual(0.3);
    expect(p).toBeLessThan(0.5);
  });

  it('planche les reps < 1', () => {
    expect(percentOf1RM(0, 10)).toBeCloseTo(percentOf1RM(1, 10));
  });

  it('retourne une valeur par défaut sûre pour une RPE non finie', () => {
    expect(percentOf1RM(8, NaN)).toBeCloseTo(percentOf1RM(8, 8));
  });
});

describe('estimatedE1rmFromRpe', () => {
  it('un set à RPE 10 donne ~ le poids ÷ %1RM de la charte', () => {
    // 5 reps @ RPE 10 → 86.3 % → 1RM ≈ 100 / 0.863
    expect(estimatedE1rmFromRpe(100, 5, 10)).toBeCloseTo(100 / 0.863, 1);
  });

  it('estime un 1RM plus haut que le poids soulevé', () => {
    expect(estimatedE1rmFromRpe(100, 8, 8)).toBeGreaterThan(100);
  });

  it('à reps/poids égaux, une RPE plus basse implique un 1RM estimé plus haut', () => {
    expect(estimatedE1rmFromRpe(100, 8, 7)).toBeGreaterThan(estimatedE1rmFromRpe(100, 8, 9));
  });

  it('retourne 0 pour un poids nul ou négatif', () => {
    expect(estimatedE1rmFromRpe(0, 8, 8)).toBe(0);
    expect(estimatedE1rmFromRpe(-10, 8, 8)).toBe(0);
  });
});

describe('loadForReps', () => {
  it('reconstitue la charge de travail depuis le 1RM estimé (aller-retour)', () => {
    const oneRm = estimatedE1rmFromRpe(100, 8, 8);
    expect(loadForReps(oneRm, 8, 8)).toBeCloseTo(100, 5);
  });

  it('arrondit au pas fourni', () => {
    const oneRm = 125;
    const load = loadForReps(oneRm, 8, 8, 2.5);
    expect(load % 2.5).toBeCloseTo(0);
  });

  it('suggère plus lourd pour une cible de reps plus basse', () => {
    const oneRm = 150;
    expect(loadForReps(oneRm, 3, 8)).toBeGreaterThan(loadForReps(oneRm, 10, 8));
  });

  it('ne descend jamais sous 0', () => {
    expect(loadForReps(0, 8, 8, 2.5)).toBe(0);
  });
});

describe('pickTopSet', () => {
  it('retourne null pour un lot vide', () => {
    expect(pickTopSet([])).toBeNull();
  });

  it('choisit le set au plus gros e1RM, pas le dernier loggé', () => {
    const sets = [
      { reps: 5, weightKg: 120, rpe: 8 }, // top set
      { reps: 10, weightKg: 90, rpe: 8 }, // back-off loggé en dernier
    ];
    const top = pickTopSet(sets);
    expect(top?.weightKg).toBe(120);
  });

  it('à poids/reps égaux, choisit le RPE le plus bas (1RM estimé le plus haut)', () => {
    const sets = [
      { reps: 8, weightKg: 100, rpe: 7 }, // a senti facile → 1RM estimé plus haut
      { reps: 8, weightKg: 100, rpe: 9 }, // a senti dur → 1RM estimé plus bas
    ];
    expect(pickTopSet(sets)?.rpe).toBe(7);
  });
});
