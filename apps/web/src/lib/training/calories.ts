import type { UserProfile } from '../user/types';

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Very rough estimate for strength training calories:
 * kcal = MET * 3.5 * weightKg / 200 * minutes
 *
 * We map avgRpe to a MET range (higher RPE = higher intensity).
 */
export function estimateStrengthWorkoutCaloriesKcal(args: {
  durationMin: number;
  avgRpe: number | null;
  profile: Pick<UserProfile, 'weightKg'> | null;
}): number | null {
  const durationMin = clamp(args.durationMin, 0, 600);
  if (durationMin <= 0) return 0;

  const weightKg = args.profile?.weightKg ?? null;
  if (!weightKg || !Number.isFinite(weightKg) || weightKg <= 0) return null;

  const rpe = args.avgRpe == null ? 8 : clamp(args.avgRpe, 6, 10);
  const met = clamp(3.5 + (rpe - 6) * 0.5, 3.5, 6.0);

  const kcal = met * 3.5 * weightKg / 200 * durationMin;
  return Math.round(kcal);
}

