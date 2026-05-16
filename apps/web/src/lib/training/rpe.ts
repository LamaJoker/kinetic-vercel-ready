import type { Exercise } from './types';

export function clampRpe(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(6, Math.min(10, value));
}

export function clampWeightKg(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export function roundToIncrementKg(weightKg: number, incrementKg: number): number {
  const inc = incrementKg > 0 ? incrementKg : 2.5;
  return Math.round(weightKg / inc) * inc;
}

export function suggestNextWeightKg(args: {
  currentWeightKg: number;
  rpe: number;
  targetRpe: number;
  exercise?: Exercise | null;
}): number {
  const { currentWeightKg, exercise } = args;
  const rpe = clampRpe(args.rpe);
  const target = clampRpe(args.targetRpe);
  const inc = exercise?.incrementKg ?? 2.5;

  const delta = rpe - target;
  let next = currentWeightKg;

  if (delta <= -1) next = currentWeightKg + inc;
  else if (delta >= 1) next = currentWeightKg - inc;

  return roundToIncrementKg(clampWeightKg(next), inc);
}

export function estimateE1rmKg(weightKg: number, reps: number): number {
  const w = clampWeightKg(weightKg);
  const r = Math.max(1, Math.min(20, Math.floor(reps)));
  // Epley formula
  return w * (1 + r / 30);
}
