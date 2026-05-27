/**
 * Muscle Balance — détecte les déséquilibres push/pull/legs sur N semaines.
 *
 * Objectif : alerter l'utilisateur si son volume est trop centré sur un
 * pattern (ex: 80% push, 5% pull → risque d'épaules antérieures dominantes,
 * douleurs cervicales). Pur, sans I/O.
 *
 * Méthode :
 *   - On classe chaque set dans une catégorie (push / pull / legs / autre)
 *     d'après ses muscles.
 *   - On compte les SETS, pas le tonnage : 1 set de squat ≠ 10× plus dur
 *     qu'un set de curls. C'est la dose qui compte pour l'équilibre.
 *   - On flag un déséquilibre si une catégorie est < 50% de la médiane des
 *     deux autres (heuristique simple), avec au moins 10 sets totaux pour
 *     éviter les faux positifs sur petit volume.
 */

export type MovementPattern = 'push' | 'pull' | 'legs' | 'other';

export interface BalanceSet {
  muscles: readonly string[];
  performedAt: string;
}

export interface BalanceReport {
  push: number;
  pull: number;
  legs: number;
  other: number;
  total: number;
  /** Catégorie sous-représentée (≤ 50% médiane des deux autres). */
  underWorked: 'push' | 'pull' | 'legs' | null;
  /** Catégorie sur-représentée (≥ 2× médiane des deux autres). */
  overWorked: 'push' | 'pull' | 'legs' | null;
  /** Vrai si on a assez de données pour parler de balance. */
  reliable: boolean;
}

const PUSH_MUSCLES = new Set(['chest', 'triceps', 'shoulders']);
const PULL_MUSCLES = new Set(['back', 'biceps', 'upper_back', 'traps', 'rear_delts']);
const LEGS_MUSCLES = new Set([
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'posterior',
  'hip_flexors',
  'adductors',
  'abductors',
]);

const MIN_SETS_FOR_RELIABLE_REPORT = 10;

/**
 * classifyPattern — détermine la catégorie dominante d'un set par vote
 * majoritaire des muscles travaillés.
 *
 * Si un set touche autant de muscles push que pull (ex: clean-and-press), on
 * tranche par ordre : push > pull > legs (arbitraire mais déterministe).
 */
export function classifyPattern(muscles: readonly string[]): MovementPattern {
  let push = 0,
    pull = 0,
    legs = 0;
  for (const m of muscles) {
    if (PUSH_MUSCLES.has(m)) push++;
    if (PULL_MUSCLES.has(m)) pull++;
    if (LEGS_MUSCLES.has(m)) legs++;
  }
  const max = Math.max(push, pull, legs);
  if (max === 0) return 'other';
  if (push === max) return 'push';
  if (pull === max) return 'pull';
  return 'legs';
}

/**
 * muscleBalance — rapport sur N semaines glissantes (défaut : 4 semaines).
 */
export function muscleBalance(
  sets: readonly BalanceSet[],
  weeksWindow: number = 4,
  now: Date = new Date(),
): BalanceReport {
  const cutoff = now.getTime() - weeksWindow * 7 * 86_400_000;
  let push = 0,
    pull = 0,
    legs = 0,
    other = 0;

  for (const s of sets) {
    const ts = Date.parse(s.performedAt);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const cat = classifyPattern(s.muscles);
    if (cat === 'push') push++;
    else if (cat === 'pull') pull++;
    else if (cat === 'legs') legs++;
    else other++;
  }

  const total = push + pull + legs + other;
  const reliable = total >= MIN_SETS_FOR_RELIABLE_REPORT;

  let underWorked: BalanceReport['underWorked'] = null;
  let overWorked: BalanceReport['overWorked'] = null;

  if (reliable) {
    const cats: Array<{ key: 'push' | 'pull' | 'legs'; value: number }> = [
      { key: 'push', value: push },
      { key: 'pull', value: pull },
      { key: 'legs', value: legs },
    ];
    for (const cat of cats) {
      const others = cats.filter((c) => c.key !== cat.key).map((c) => c.value);
      const median = others.sort((a, b) => a - b)[Math.floor(others.length / 2)] ?? 0;
      // Sous-travaillé : moitié de la médiane des autres
      if (median > 0 && cat.value * 2 <= median) {
        underWorked = cat.key;
      }
      // Sur-travaillé : plus du double de la médiane des autres
      if (median > 0 && cat.value >= median * 2) {
        overWorked = cat.key;
      }
    }
  }

  return { push, pull, legs, other, total, underWorked, overWorked, reliable };
}
