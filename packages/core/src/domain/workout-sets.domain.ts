/**
 * Séries d'une séance : échauffement ou travail, « la dernière fois » et
 * montée d'échauffement. Pur, zéro I/O.
 *
 * Une série sans `kind` est une série de travail : les séances stockées avant
 * l'apparition du champ restent valables telles quelles (stockage, import,
 * export, synchro). Les échauffements sont exclus de tout ce qui mesure la
 * performance (tonnage, records, e1RM, statistiques, succès, progression).
 */
import { calculatePlates } from './plate-calculator.domain.js';

export type SetKind = 'work' | 'warmup';

export interface KindedSet {
  kind?: SetKind | (string & {}) | undefined;
}

export interface LoadedSet extends KindedSet {
  weightKg: number;
  reps: number;
}

export function isWarmupSet(set: KindedSet): boolean {
  return set.kind === 'warmup';
}

/** Séries de travail seulement (sans les échauffements). */
export function workSetsOf<T extends KindedSet>(sets: readonly T[]): T[] {
  return sets.filter((s) => !isWarmupSet(s));
}

export function warmupSetsOf<T extends KindedSet>(sets: readonly T[]): T[] {
  return sets.filter(isWarmupSet);
}

interface SessionLike<S> {
  id: string;
  startedAt: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly S[] }>;
}

export interface LastPerformance<S> {
  sessionId: string;
  startedAt: string;
  /** Séries de travail, dans l'ordre. */
  sets: S[];
}

/**
 * Dernière séance (la plus récente par date de début) où l'exercice a eu au
 * moins une série de travail. `excludeSessionId` : la séance en cours.
 */
export function lastPerformance<S extends KindedSet>(
  sessions: ReadonlyArray<SessionLike<S>>,
  exerciseId: string,
  excludeSessionId?: string | null,
): LastPerformance<S> | null {
  let best: LastPerformance<S> | null = null;
  let bestMs = -Infinity;
  for (const s of sessions) {
    if (s.id === excludeSessionId) continue;
    const ms = Date.parse(s.startedAt);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    const entry = s.entries.find((e) => e.exerciseId === exerciseId);
    const sets = entry ? workSetsOf(entry.sets) : [];
    if (sets.length === 0) continue;
    best = { sessionId: s.id, startedAt: s.startedAt, sets };
    bestMs = ms;
  }
  return best;
}

/** « 42,5×8 » (charge à la française, sans unité) ; « 8 reps » au poids du corps. */
export function formatSetShort(set: LoadedSet): string {
  const kg = Math.round((Number(set.weightKg) || 0) * 100) / 100;
  if (kg <= 0) return `${set.reps} reps`;
  return `${String(kg).replace('.', ',')}×${set.reps}`;
}

/** « 40×8 · 42,5×8 · 42,5×7 ». */
export function formatSetsShort(sets: readonly LoadedSet[]): string {
  return sets.map(formatSetShort).join(' · ');
}

/** Série de la dernière fois qui correspond à la n-ième série de travail (la dernière au-delà). */
export function matchingLastSet<S>(lastSets: readonly S[], workIndex: number): S | null {
  if (lastSets.length === 0) return null;
  return lastSets[Math.max(0, Math.min(workIndex, lastSets.length - 1))] ?? null;
}

export interface SetTarget {
  weightKg: number;
  reps: number;
  /** `coach` : progression proposée ; `last` : comme la dernière fois. */
  source: 'coach' | 'last';
}

/**
 * Valeurs à pré-remplir pour la prochaine série de travail : la série
 * correspondante de la dernière fois, sauf si le coach propose de monter par
 * rapport à elle (charge plus lourde, ou même charge et plus de reps) — sa cible
 * passe alors devant. Le coach qui propose de redescendre ne l'emporte pas : il
 * reste affiché (et applicable d'un geste) dans son encart. Sans historique :
 * null (on garde la saisie en cours).
 */
export function nextSetTarget(input: {
  lastSets: readonly LoadedSet[];
  workIndex: number;
  coach?: LoadedSet | null;
}): SetTarget | null {
  const last = matchingLastSet(input.lastSets, input.workIndex);
  if (!last) return null;
  const c = input.coach;
  const higher =
    !!c &&
    c.weightKg > 0 &&
    c.reps > 0 &&
    (c.weightKg > last.weightKg || (c.weightKg === last.weightKg && c.reps > last.reps));
  return higher
    ? { weightKg: c.weightKg, reps: c.reps, source: 'coach' }
    : { weightKg: last.weightKg, reps: last.reps, source: 'last' };
}

export interface WarmupInput {
  /** Charge de travail prévue (kg). */
  workKg: number;
  /** Exercice à la barre : on commence barre seule et on arrondit aux disques. */
  barbell: boolean;
  barKg?: number;
  /** Disques disponibles (réglages du calculateur de disques). */
  plates?: readonly number[];
  /** Pas de charge des exercices sans barre (haltères, machine…). */
  incrementKg?: number;
}

/** Montée classique : barre seule ×10 puis 40 % ×8, 60 % ×5, 80 % ×3. */
const BAR_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0.4, 8],
  [0.6, 5],
  [0.8, 3],
];
/** Sans barre : 40 % ×10, 60 % ×6, 80 % ×3. */
const FREE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0.4, 10],
  [0.6, 6],
  [0.8, 3],
];

/**
 * Séries d'échauffement pour une charge de travail : charges arrondies vers le
 * bas à ce qu'on peut réellement charger, strictement croissantes et sous la
 * charge de travail. Vide si la charge de travail est trop légère.
 */
export function warmupRamp(input: WarmupInput): Array<{ weightKg: number; reps: number }> {
  const work = Number(input.workKg);
  if (!Number.isFinite(work) || work <= 0) return [];
  const out: Array<{ weightKg: number; reps: number }> = [];
  const push = (weightKg: number, reps: number): void => {
    const prev = out.at(-1)?.weightKg ?? 0;
    if (weightKg > prev && weightKg < work) out.push({ weightKg, reps });
  };

  if (input.barbell) {
    const bar = input.barKg && input.barKg > 0 ? input.barKg : 20;
    if (work <= bar) return [];
    push(bar, 10);
    for (const [pct, reps] of BAR_STEPS) {
      const r = calculatePlates({
        // Paliers ronds (2,5 kg) : pas de micro-disques pour s'échauffer.
        targetKg: Math.floor((work * pct) / 2.5 + 1e-9) * 2.5,
        barKg: bar,
        ...(input.plates?.length ? { availablePlates: input.plates } : {}),
      });
      push(r.achievedKg, reps);
    }
    return out;
  }

  const inc = input.incrementKg && input.incrementKg > 0 ? input.incrementKg : 2.5;
  for (const [pct, reps] of FREE_STEPS) {
    push(Math.round(Math.floor((work * pct) / inc + 1e-9) * inc * 100) / 100, reps);
  }
  return out;
}
