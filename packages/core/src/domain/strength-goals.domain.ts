/**
 * Objectifs de force — « Squat 140 kg », « Développé couché e1RM 100 kg »,
 * « Tractions 20 kg × 8 » — avec progression actuelle, tendance et date
 * estimée d'atteinte. Pur, zéro I/O.
 *
 * Tendance : régression de Theil–Sen (médiane des pentes entre paires de
 * séances) sur la meilleure e1RM de chaque séance des 6 à 12 dernières
 * semaines, séries de travail en répétitions seulement. Robuste : une séance
 * ratée ou un record isolé ne fait pas basculer l'estimation.
 */
import { e1rm } from './progression.domain.js';
import { isTimedSet, workSetsOf, type LoadedSet, type TimedFields } from './workout-sets.domain.js';

export type StrengthGoalKind = 'weight' | 'e1rm' | 'reps';

export interface StrengthGoal {
  id: string;
  exerciseId: string;
  /** weight : soulever la charge (1 rep) ; e1rm : e1RM visée ; reps : targetReps à la charge. */
  kind: StrengthGoalKind;
  targetKg: number;
  /** Répétitions visées (kind 'reps'). */
  targetReps?: number;
  createdAt: string;
  /** Première série qui a rempli l'objectif. */
  achievedAt?: string;
}

type GoalSet = LoadedSet & TimedFields & { performedAt?: string };
export interface GoalSession {
  startedAt: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly GoalSet[] }>;
}

export interface E1rmPoint {
  /** Début de la séance (ms). */
  t: number;
  e1rm: number;
}

const DAY = 86_400_000;
/** Au-delà, l'estimation n'a plus de sens : « pas avant longtemps ». */
export const GOAL_HORIZON_DAYS = 730;

const loadSets = (sets: readonly GoalSet[]): GoalSet[] =>
  workSetsOf(sets).filter((s) => !isTimedSet(s) && s.reps >= 1);

/** Meilleure e1RM de chaque séance où l'exercice a été fait, dans l'ordre chronologique. */
export function sessionBestE1rms(
  sessions: readonly GoalSession[],
  exerciseId: string,
): E1rmPoint[] {
  const out: E1rmPoint[] = [];
  for (const s of sessions) {
    let best = 0;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of loadSets(e.sets)) best = Math.max(best, e1rm(set.weightKg, set.reps));
    }
    const t = Date.parse(s.startedAt);
    if (best > 0 && Number.isFinite(t)) out.push({ t, e1rm: best });
  }
  return out.sort((a, b) => a.t - b.t);
}

const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};

export interface Trend {
  /** kg d'e1RM gagnés par jour (Theil–Sen). */
  perDay: number;
  /** Valeur de la droite aujourd'hui. */
  now: number;
  /** Séances prises en compte. */
  n: number;
}

/**
 * Tendance robuste sur 12 semaines (6 si elles suffisent : ≥ 6 séances).
 * null avec moins de 3 séances ou moins de 14 jours d'écart.
 */
export function robustTrend(points: readonly E1rmPoint[], now: number): Trend | null {
  let pts = points.filter((p) => p.t <= now && p.t >= now - 84 * DAY);
  const recent = pts.filter((p) => p.t >= now - 42 * DAY);
  if (recent.length >= 6) pts = recent;
  if (pts.length < 3 || pts.at(-1)!.t - pts[0]!.t < 14 * DAY) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dt = (pts[j]!.t - pts[i]!.t) / DAY;
      if (dt >= 1) slopes.push((pts[j]!.e1rm - pts[i]!.e1rm) / dt);
    }
  if (slopes.length === 0) return null;
  const perDay = median(slopes);
  return {
    perDay,
    now: median(pts.map((p) => p.e1rm + perDay * ((now - p.t) / DAY))),
    n: pts.length,
  };
}

/**
 * e1RM équivalente à l'objectif, avec la même formule que le reste de l'app :
 * soulever la charge visée (1 rep, ou targetReps) donne exactement 100 %.
 */
export function goalTargetE1rm(goal: StrengthGoal): number {
  if (goal.kind === 'e1rm') return goal.targetKg;
  return e1rm(goal.targetKg, goal.kind === 'reps' ? (goal.targetReps ?? 1) : 1);
}

/** Une série de travail remplit-elle l'objectif ? */
export function setMeetsGoal(goal: StrengthGoal, set: GoalSet): boolean {
  if (set.kind === 'warmup' || isTimedSet(set) || !(set.reps >= 1)) return false;
  if (goal.kind === 'e1rm') return e1rm(set.weightKg, set.reps) >= goal.targetKg - 1e-9;
  return (
    set.weightKg >= goal.targetKg && set.reps >= (goal.kind === 'reps' ? (goal.targetReps ?? 1) : 1)
  );
}

/** Date de la première série qui remplit l'objectif (null si jamais). */
export function goalAchievedAt(
  goal: StrengthGoal,
  sessions: readonly GoalSession[],
): string | null {
  let first: string | null = null;
  for (const s of sessions)
    for (const e of s.entries) {
      if (e.exerciseId !== goal.exerciseId) continue;
      for (const set of e.sets) {
        const at = set.performedAt ?? s.startedAt;
        if (setMeetsGoal(goal, set) && (first === null || at < first)) first = at;
      }
    }
  return first;
}

export type GoalState =
  | 'achieved' // rempli
  | 'ready' // e1RM au niveau de la cible : à tenter
  | 'on-track' // date estimée
  | 'flat' // tendance plate ou en baisse
  | 'too-far' // au-delà de GOAL_HORIZON_DAYS
  | 'few-data' // pas assez de séances pour une tendance
  | 'no-data'; // jamais fait

export interface GoalStatus {
  goal: StrengthGoal;
  state: GoalState;
  /** e1RM récente (meilleure des 4 dernières semaines, sinon dernière connue). */
  current: number;
  target: number;
  /** current / target, 0–100. */
  pct: number;
  /** Date estimée (ms), état 'on-track'. */
  eta?: number;
  /** kg d'e1RM par semaine (0 sans tendance). */
  perWeek: number;
}

export function evaluateGoal(
  goal: StrengthGoal,
  sessions: readonly GoalSession[],
  now: number,
): GoalStatus {
  const target = goalTargetE1rm(goal);
  const points = sessionBestE1rms(sessions, goal.exerciseId).filter((p) => p.t <= now);
  const recent = points.filter((p) => p.t >= now - 28 * DAY);
  const current = Math.max(0, ...(recent.length ? recent : points.slice(-1)).map((p) => p.e1rm));
  const pct = target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 0;
  const trend = robustTrend(points, now);
  const base = { goal, current, target, pct, perWeek: trend ? trend.perDay * 7 : 0 };
  const achievedAt = goal.achievedAt ?? goalAchievedAt(goal, sessions);
  if (achievedAt) return { ...base, goal: { ...goal, achievedAt }, pct: 100, state: 'achieved' };
  if (points.length === 0) return { ...base, state: 'no-data' };
  if (current >= target || (trend && trend.now >= target)) return { ...base, state: 'ready' };
  if (!trend) return { ...base, state: 'few-data' };
  // Moins de 0,1 % de l'e1RM par semaine : plat (bruit de mesure).
  if (trend.perDay * 7 < Math.max(0.05, trend.now * 0.001)) return { ...base, state: 'flat' };
  const days = (target - trend.now) / trend.perDay;
  if (days > GOAL_HORIZON_DAYS) return { ...base, state: 'too-far' };
  return { ...base, state: 'on-track', eta: now + Math.max(7, Math.ceil(days)) * DAY };
}

const kg = (n: number): string =>
  `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ')}\u00a0kg`;

/** « Squat 140 kg », « Squat e1RM 150 kg », « Tractions 20 kg × 8 ». */
export function goalLabel(goal: StrengthGoal, exerciseName: string): string {
  if (goal.kind === 'e1rm') return `${exerciseName} e1RM ${kg(goal.targetKg)}`;
  if (goal.kind === 'reps')
    return `${exerciseName} ${kg(goal.targetKg)}\u00a0×\u00a0${goal.targetReps ?? 1}`;
  return `${exerciseName} ${kg(goal.targetKg)}`;
}

const day = (ms: number, now: number): string => {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('fr-FR', opts);
};

/** Phrase d'estimation : « Vers le 14 mars », « Au rythme actuel, pas atteignable — tendance plate »… */
export function goalEtaLabel(status: GoalStatus, now: number): string {
  switch (status.state) {
    case 'achieved': {
      const at = Date.parse(status.goal.achievedAt ?? '');
      return Number.isFinite(at) ? `Atteint le ${day(at, now)}` : 'Atteint';
    }
    case 'ready':
      return 'À ta portée : tente-le à la prochaine séance';
    case 'on-track':
      return `Vers le ${day(status.eta!, now)}`;
    case 'flat':
      return 'Au rythme actuel, pas atteignable — tendance plate';
    case 'too-far':
      return 'Au rythme actuel, pas avant 2 ans — vise une étape intermédiaire';
    case 'few-data':
      return 'Encore quelques séances pour estimer une date';
    default:
      return 'Pas encore de séance sur cet exercice';
  }
}

/**
 * Marque les objectifs remplis. `newly` : ceux remplis APRÈS leur création (à
 * célébrer) ; un objectif déjà dépassé à sa création est marqué sans fête.
 */
export function syncAchievedGoals(
  goals: readonly StrengthGoal[],
  sessions: readonly GoalSession[],
): { goals: StrengthGoal[]; newly: StrengthGoal[]; changed: boolean } {
  const newly: StrengthGoal[] = [];
  let changed = false;
  const next = goals.map((g) => {
    if (g.achievedAt) return g;
    const at = goalAchievedAt(g, sessions);
    if (!at) return g;
    changed = true;
    const done = { ...g, achievedAt: at };
    if (at >= g.createdAt) newly.push(done);
    return done;
  });
  return { goals: next, newly, changed };
}

/** Objectif en cours le plus proche (meilleur pourcentage), pour l'accueil. */
export function closestGoal(statuses: readonly GoalStatus[]): GoalStatus | null {
  let best: GoalStatus | null = null;
  for (const s of statuses) if (s.state !== 'achieved' && (!best || s.pct > best.pct)) best = s;
  return best;
}

/** Objectifs valides lus du stockage (tolère les données abîmées). */
export function normalizeGoals(raw: unknown): StrengthGoal[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (g): g is StrengthGoal =>
      !!g &&
      typeof g === 'object' &&
      typeof g.id === 'string' &&
      typeof g.exerciseId === 'string' &&
      (g.kind === 'weight' || g.kind === 'e1rm' || g.kind === 'reps') &&
      g.targetKg > 0 &&
      typeof g.createdAt === 'string',
  );
}

/** Message d'erreur de saisie, ou null si l'objectif est valide. */
export function validateGoalInput(input: {
  exerciseId: string;
  kind: StrengthGoalKind;
  targetKg: number;
  targetReps?: number;
}): string | null {
  if (!input.exerciseId) return 'Choisis un exercice.';
  if (!(input.targetKg > 0 && input.targetKg <= 1000))
    return 'Indique une charge entre 1 et 1000 kg.';
  const r = input.targetReps ?? 0;
  if (input.kind === 'reps' && !(Number.isInteger(r) && r >= 2 && r <= 50))
    return 'Indique un nombre de répétitions entre 2 et 50.';
  return null;
}
