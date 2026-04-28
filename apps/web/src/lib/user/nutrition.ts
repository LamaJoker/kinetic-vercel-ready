import type { ActivityLevel, UserGoal, UserProfile } from './types';

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function activityMultiplier(level: ActivityLevel): number {
  switch (level) {
    case 'sedentary':   return 1.2;
    case 'light':       return 1.375;
    case 'moderate':    return 1.55;
    case 'active':      return 1.725;
    case 'very_active': return 1.9;
    default:            return 1.55;
  }
}

export function estimateBmrKcal(profile: UserProfile): number {
  // Mifflin-St Jeor (kcal/day)
  const w = Math.max(30, Math.min(250, profile.weightKg));
  const h = Math.max(120, Math.min(230, profile.heightCm));
  const a = clampInt(profile.ageYears, 12, 90);
  const s = profile.sex === 'male' ? 5 : -161;
  return 10 * w + 6.25 * h - 5 * a + s;
}

export function estimateTdeeKcal(profile: UserProfile): number {
  return estimateBmrKcal(profile) * activityMultiplier(profile.activity);
}

export function goalDeltaKcal(goal: UserGoal): number {
  // Conservative defaults; user can fine-tune later.
  switch (goal) {
    case 'lose_fat':    return -400;
    case 'gain_muscle': return +250;
    case 'recomp':      return -150;
    case 'performance': return 0;
    default:            return 0;
  }
}

export function estimateTargetCaloriesKcal(profile: UserProfile): number {
  const tdee = estimateTdeeKcal(profile);
  return Math.round(tdee + goalDeltaKcal(profile.goal));
}

