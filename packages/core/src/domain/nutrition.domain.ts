/**
 * Sources : Mifflin-St Jeor (1990), ISSN 2023, ACSM/AND/DC 2016, Helms 2014
 */

export type Sex           = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type Goal          = 'lose_fat' | 'gain_muscle' | 'recomp' | 'performance' | 'maintain';

export interface UserMeasurements {
  sex: Sex; ageYears: number; heightCm: number; weightKg: number;
  bodyFatPct: number | null; activity: ActivityLevel; goal: Goal;
}

export interface MacroTarget {
  kcal: number; proteinG: number; carbsG: number;
  fatG: number; fiberG: number; waterMl: number;
}

export interface NutritionPlan {
  bmrKcal: number; tdeeKcal: number; targetKcal: number;
  macros: MacroTarget; notes: string[]; weeklyFatLossG: number | null;
}

const ACTIVITY_MULT: Record<ActivityLevel, number> = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9,
};

export function bmrKcal(m: UserMeasurements): number {
  if (m.bodyFatPct && m.bodyFatPct > 5 && m.bodyFatPct < 60) {
    // Katch-McArdle — plus précis si % MG connu
    return Math.round(370 + 21.6 * m.weightKg * (1 - m.bodyFatPct / 100));
  }
  // Mifflin-St Jeor
  const base = 10 * m.weightKg + 6.25 * m.heightCm - 5 * m.ageYears;
  return Math.round(m.sex === 'male' ? base + 5 : base - 161);
}

export function tdeeKcal(m: UserMeasurements): number {
  return Math.round(bmrKcal(m) * ACTIVITY_MULT[m.activity]);
}

export function buildNutritionPlan(m: UserMeasurements): NutritionPlan {
  const bmr  = bmrKcal(m);
  const tdee = tdeeKcal(m);
  const deltas: Record<Goal, number> = {
    lose_fat:    Math.max(-700, Math.round(-tdee * 0.20)),
    gain_muscle: Math.min(350, Math.round(5 * m.weightKg)),
    recomp:      Math.round(-tdee * 0.08),
    performance: 0, maintain: 0,
  };
  const target = Math.round(tdee + deltas[m.goal]);

  // Protéines : ISSN 2023 (1.6–2.4 g/kg selon objectif)
  const protFactors: Record<Goal, number> = {
    lose_fat: 2.4, gain_muscle: 1.8, recomp: 2.2, performance: 1.8, maintain: 1.6,
  };
  // Protéines : plafonnées au min(g/kg selon objectif, 35% des kcal).
  // Le plafond à 35% kcal évite qu'un déficit très agressif (ex: 1200 kcal)
  // pousse les protéines à des niveaux irréalistes (> 3 g/kg) qui surchargeraient
  // les reins et déplaceraient totalement glucides + lipides.
  // Limite connue : en déficit modéré (≥ 1600 kcal), la contrainte g/kg s'applique
  // avant le plafond 35% kcal → résultat correct. En déficit sévère (< 1400 kcal),
  // le plafond 35% peut sous-estimer légèrement (157 g vs 192 g pour 80 kg).
  // Source : ISSN Position Stand 2023, Helms 2014 (déficit ≤ 25% TDEE recommandé).
  const proteinG = Math.round(Math.min(m.weightKg * protFactors[m.goal], (target * 0.35) / 4));

  // Lipides : min 0.5 g/kg + 28 % kcal
  const fatG = Math.round(Math.max(0.5 * m.weightKg, (target * 0.28) / 9));

  // Glucides : calories restantes (min 100 g/j)
  const carbsG = Math.max(100, Math.round((target - proteinG * 4 - fatG * 9) / 4));

  const notes: string[] = ['Calculs TDEE ±10 % — réévalue si poids stagne 2 semaines.'];
  if (m.goal === 'lose_fat') notes.push('Cible : −0.5 à 1 % du poids / semaine (préserver la masse).');
  if (m.goal === 'gain_muscle') notes.push('Cible : +0.25–0.5 kg / semaine novice, +0.1 kg intermédiaire.');
  if (proteinG / m.weightKg >= 2) notes.push('Protéines élevées : 4–5 prises de 30–40 g / repas.');

  return {
    bmrKcal: bmr, tdeeKcal: tdee, targetKcal: target,
    macros: {
      kcal: target, proteinG, carbsG, fatG,
      fiberG: m.sex === 'male' ? 38 : 25,
      waterMl: Math.round(m.weightKg * 35 + (['active','very_active'].includes(m.activity) ? 500 : 0)),
    },
    notes,
    weeklyFatLossG: deltas[m.goal] < 0 ? Math.round((-deltas[m.goal] * 7) / 7700 * 1000) : null,
  };
}

export interface MealTiming {
  mealName: string; kcal: number; proteinG: number;
  carbsG: number; fatG: number; notes: string;
}

export function mealTimingPlan(plan: NutritionPlan, training: boolean): MealTiming[] {
  const m = plan.macros;
  if (!training) return [
    { mealName: 'Matin', kcal: Math.round(m.kcal*.35), proteinG: Math.round(m.proteinG*.34), carbsG: Math.round(m.carbsG*.40), fatG: Math.round(m.fatG*.30), notes: 'Œufs, fromage blanc, flocons d\'avoine.' },
    { mealName: 'Déjeuner', kcal: Math.round(m.kcal*.35), proteinG: Math.round(m.proteinG*.34), carbsG: Math.round(m.carbsG*.35), fatG: Math.round(m.fatG*.35), notes: 'Repas équilibré — glucides légèrement réduits jour repos.' },
    { mealName: 'Dîner', kcal: Math.round(m.kcal*.30), proteinG: Math.round(m.proteinG*.32), carbsG: Math.round(m.carbsG*.25), fatG: Math.round(m.fatG*.35), notes: 'Protéines lentes (caséine, œufs), légumes à volonté.' },
  ];
  return [
    { mealName: 'Matin', kcal: Math.round(m.kcal*.28), proteinG: Math.round(m.proteinG*.24), carbsG: Math.round(m.carbsG*.28), fatG: Math.round(m.fatG*.28), notes: 'Petit-déjeuner complet.' },
    { mealName: 'Pré-séance (−90 min)', kcal: Math.round(m.kcal*.20), proteinG: Math.round(m.proteinG*.20), carbsG: Math.round(m.carbsG*.30), fatG: Math.round(m.fatG*.10), notes: 'Glucides complexes + protéines légères. Limiter lipides.' },
    { mealName: 'Post-séance (< 2 h)', kcal: Math.round(m.kcal*.25), proteinG: Math.round(m.proteinG*.30), carbsG: Math.round(m.carbsG*.25), fatG: Math.round(m.fatG*.15), notes: 'Fenêtre anabolique : whey + glucides rapides.' },
    { mealName: 'Dîner', kcal: Math.round(m.kcal*.27), proteinG: Math.round(m.proteinG*.26), carbsG: Math.round(m.carbsG*.17), fatG: Math.round(m.fatG*.47), notes: 'Caséine ou œufs — lipides OK le soir.' },
  ];
}

export function macroProgress(
  consumed: { kcal: number; proteinG: number; carbsG: number; fatG: number },
  target: MacroTarget,
) {
  const pct = (a: number, b: number) => Math.min(150, Math.round((a / Math.max(1, b)) * 100));
  const kcalPct = pct(consumed.kcal, target.kcal);
  const proteinPct = pct(consumed.proteinG, target.proteinG);
  const carbsPct = pct(consumed.carbsG, target.carbsG);
  const fatPct = pct(consumed.fatG, target.fatG);
  return {
    kcalPct, proteinPct, carbsPct, fatPct,
    score: Math.round((proteinPct * 2 + carbsPct + fatPct + kcalPct) / 5),
  };
}