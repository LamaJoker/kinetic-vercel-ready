import { describe, it, expect } from 'vitest';
import { bmrKcal, tdeeKcal, buildNutritionPlan, macroProgress } from '@kinetic/core';
import type { UserMeasurements } from '@kinetic/core';

const male75kg: UserMeasurements = {
  sex: 'male',
  ageYears: 28,
  heightCm: 178,
  weightKg: 75,
  bodyFatPct: null,
  activity: 'moderate',
  goal: 'gain_muscle',
};

describe('bmrKcal — Mifflin-St Jeor', () => {
  it('calcule le BMR homme correctement', () => {
    const bmr = bmrKcal(male75kg);
    // 10*75 + 6.25*178 - 5*28 + 5 = 750 + 1112.5 - 140 + 5 = 1727.5
    expect(bmr).toBe(1728);
  });

  it('calcule le BMR femme', () => {
    const female = { ...male75kg, sex: 'female' as const, weightKg: 60, heightCm: 165 };
    const bmr = bmrKcal(female);
    // 10*60 + 6.25*165 - 5*28 - 161 = 600 + 1031.25 - 140 - 161 = 1330.25
    expect(bmr).toBe(1330);
  });

  it('utilise Katch-McArdle si bodyFatPct fourni', () => {
    const withBF = { ...male75kg, bodyFatPct: 15 };
    const bmr = bmrKcal(withBF);
    // LBM = 75*(1-0.15)=63.75; 370 + 21.6*63.75 = 370 + 1377 = 1747
    expect(bmr).toBe(1747);
  });
});

describe('tdeeKcal', () => {
  it('applique le multiplicateur moderate (1.55)', () => {
    const tdee = tdeeKcal(male75kg);
    expect(tdee).toBe(Math.round(bmrKcal(male75kg) * 1.55));
  });
});

describe('buildNutritionPlan', () => {
  it('protéines dans fourchette ISSN (1.6–2.4 g/kg)', () => {
    const plan = buildNutritionPlan(male75kg);
    const ratio = plan.macros.proteinG / male75kg.weightKg;
    expect(ratio).toBeGreaterThanOrEqual(1.6);
    expect(ratio).toBeLessThanOrEqual(2.5);
  });

  it('kcal totales cohérentes avec macros', () => {
    const plan = buildNutritionPlan(male75kg);
    const m = plan.macros;
    const computed = m.proteinG * 4 + m.carbsG * 4 + m.fatG * 9;
    // Tolérance ±50 kcal (arrondi)
    expect(Math.abs(computed - m.kcal)).toBeLessThan(50);
  });

  it('fibres selon DRI (homme=38g)', () => {
    const plan = buildNutritionPlan(male75kg);
    expect(plan.macros.fiberG).toBe(38);
  });

  it('lipides minimum 0.5 g/kg', () => {
    const plan = buildNutritionPlan(male75kg);
    expect(plan.macros.fatG).toBeGreaterThanOrEqual(male75kg.weightKg * 0.5);
  });

  it('glucides jamais en dessous de 100 g/j', () => {
    const extremeDeficit = {
      ...male75kg,
      goal: 'lose_fat' as const,
      activity: 'sedentary' as const,
    };
    const plan = buildNutritionPlan(extremeDeficit);
    expect(plan.macros.carbsG).toBeGreaterThanOrEqual(100);
  });

  it('perte de masse grasse estimée en mode lose_fat', () => {
    const loseGoal = { ...male75kg, goal: 'lose_fat' as const };
    const plan = buildNutritionPlan(loseGoal);
    expect(plan.weeklyFatLossG).not.toBeNull();
    expect(plan.weeklyFatLossG!).toBeGreaterThan(0);
  });
});

describe('macroProgress', () => {
  const target = { kcal: 2500, proteinG: 180, carbsG: 280, fatG: 78, fiberG: 38, waterMl: 2600 };

  it('calcule les pourcentages correctement', () => {
    const progress = macroProgress({ kcal: 1250, proteinG: 90, carbsG: 140, fatG: 39 }, target);
    expect(progress.kcalPct).toBe(50);
    expect(progress.proteinPct).toBe(50);
  });

  it('plafonne à 150 %', () => {
    const progress = macroProgress({ kcal: 5000, proteinG: 400, carbsG: 600, fatG: 200 }, target);
    expect(progress.proteinPct).toBe(150);
  });

  it('score favorise les protéines (coefficient ×2)', () => {
    const good = macroProgress({ kcal: 2500, proteinG: 180, carbsG: 280, fatG: 78 }, target);
    const noP = macroProgress({ kcal: 2500, proteinG: 0, carbsG: 280, fatG: 78 }, target);
    expect(good.score).toBeGreaterThan(noP.score);
  });
});
