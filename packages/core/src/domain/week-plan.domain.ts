/**
 * Semaine qui s'adapte — planification pure des séances d'un programme.
 *
 * Entrées : les séances prévues de la semaine (ordre du cycle + jour prévu),
 * ce qui a déjà été fait, le jour courant et les ajustements de l'utilisateur
 * (séance déplacée à la main, jours indisponibles, séances sautées).
 *
 * Règles :
 *  - une séance faite reste au jour où elle a été faite (✓) ;
 *  - une séance ratée (jour passé) ou tombant un jour indisponible glisse au
 *    prochain jour libre, en gardant l'ordre du cycle et au moins un jour de
 *    repos entre deux séances qui sollicitent les mêmes muscles ;
 *  - si plus aucun jour ne convient avant dimanche, la séance est « à sauter »
 *    (proposé avec une explication, l'utilisateur confirme).
 *
 * Jours : 0 = lundi … 6 = dimanche. Pur : aucun accès au stockage ni à l'horloge.
 */

export interface PlanSession {
  /** Identifiant stable dans la semaine (sert aux déplacements manuels). */
  key: string;
  name: string;
  muscles: readonly string[];
  /** Jour prévu par le programme (0 = lundi). */
  day: number;
}

/** Séance faite cette semaine (jour 0 = lundi, nom si connu). */
export interface PlanDone {
  day: number;
  name?: string | null;
}

/** Ajustements de l'utilisateur pour la semaine. */
export interface WeekAdjust {
  /** Séance (key) → jour choisi. */
  moves?: Readonly<Record<string, number>>;
  /** Séances que l'utilisateur a choisi de sauter. */
  skipped?: readonly string[];
  /** Jours où il ne peut pas s'entraîner. */
  unavailable?: readonly number[];
}

/** done ✓ · planned · moved ↷ · unplaced (proposé : sauter) · skipped */
export type PlanStatus = 'done' | 'planned' | 'moved' | 'unplaced' | 'skipped';

export interface PlanItem {
  key: string;
  name: string;
  baseDay: number;
  /** Jour retenu (null : sautée ou sans place). */
  day: number | null;
  status: PlanStatus;
  /** Déplacée à la main. */
  manual: boolean;
}

export interface PlanDay {
  day: number;
  /** « L », « M »… */
  short: string;
  /** « lundi »… */
  name: string;
  isToday: boolean;
  isPast: boolean;
  unavailable: boolean;
  item: PlanItem | null;
}

export interface WeekPlan {
  items: PlanItem[];
  days: PlanDay[];
  /** Messages clairs : « Pull B déplacé à jeudi ». */
  messages: string[];
  /** Séance prévue aujourd'hui et pas encore faite. */
  today: PlanItem | null;
  doneCount: number;
  total: number;
}

export const PLAN_DAY_NAMES = [
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
] as const;
const SHORT = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

/** getDay() JS (0 = dimanche) → 0 = lundi. */
export function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^jambes\b/, 'legs')
    .replace(/^haut du corps\b/, 'upper')
    .replace(/^bas du corps\b/, 'lower');
}

/** « Push A » ≈ « push a » ; « Jambes » ≈ « Jambes B (lourd) ». */
export function sameSessionName(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x !== '' && y !== '' && (x === y || x.includes(y) || y.includes(x));
}

function sharesMuscles(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map(norm));
  return b.some((m) => set.has(norm(m)));
}

function validDay(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6;
}

/**
 * Planifie la semaine.
 * @param sessions séances prévues, dans l'ordre du cycle
 * @param done séances faites cette semaine (jours ≤ aujourd'hui)
 * @param today jour courant (0 = lundi)
 */
export function planWeek(
  sessions: readonly PlanSession[],
  done: readonly PlanDone[],
  today: number,
  adjust: WeekAdjust = {},
): WeekPlan {
  const unavailable = new Set((adjust.unavailable ?? []).filter(validDay));
  const skipped = new Set(adjust.skipped ?? []);
  const moves = adjust.moves ?? {};
  const items: PlanItem[] = sessions.map((s) => ({
    key: s.key,
    name: s.name,
    baseDay: s.day,
    day: null,
    status: 'planned',
    manual: false,
  }));
  const muscles = new Map(sessions.map((s) => [s.key, s.muscles]));
  /** jour → séance posée (faite ou planifiée) */
  const taken = new Map<number, PlanItem>();

  // 1. Séances faites : par nom d'abord, sinon la première en attente du cycle.
  const pending = (): PlanItem[] => items.filter((i) => i.status === 'planned');
  for (const d of [...done].filter((x) => validDay(x.day)).sort((a, b) => a.day - b.day)) {
    const open = pending();
    const it = (d.name && open.find((i) => sameSessionName(i.name, d.name!))) || open[0];
    if (!it) break;
    it.status = 'done';
    it.day = d.day;
    if (!taken.has(d.day)) taken.set(d.day, it);
  }
  const trainedToday = done.some((d) => d.day === today);
  const earliest = today + (trainedToday ? 1 : 0);
  const free = (d: number): boolean => !unavailable.has(d) && !taken.has(d);
  /** Repos respecté autour du jour d ? Deux séances à leur jour prévu ne comptent pas :
   *  le programme tel qu'il est écrit fait foi. */
  const restOk = (d: number, it: PlanItem): boolean => {
    const m = muscles.get(it.key) ?? [];
    for (const n of [d - 1, d + 1]) {
      const o = taken.get(n);
      if (!o || o === it || !sharesMuscles(m, muscles.get(o.key) ?? [])) continue;
      if (d !== it.baseDay || o.day !== o.baseDay) return false;
    }
    return true;
  };

  // 2. Séances sautées, puis déplacements manuels (le choix de l'utilisateur prime).
  const messages: string[] = [];
  for (const it of pending()) {
    if (skipped.has(it.key)) {
      it.status = 'skipped';
      continue;
    }
    const m = moves[it.key];
    if (validDay(m) && m >= earliest && free(m)) {
      it.day = m;
      it.manual = true;
      it.status = m === it.baseDay ? 'planned' : 'moved';
      taken.set(m, it);
    }
  }

  // 3. Le reste, dans l'ordre du cycle : jour prévu, sinon le prochain jour libre
  //    avec un jour de repos avant/après toute séance qui sollicite les mêmes muscles.
  let prev = -1;
  const unplaced: PlanItem[] = [];
  for (const it of pending()) {
    if (it.manual) continue;
    let placed = false;
    for (let d = Math.max(it.baseDay, earliest, prev + 1); d <= 6; d++) {
      if (free(d) && restOk(d, it)) {
        it.day = d;
        it.status = d === it.baseDay ? 'planned' : 'moved';
        taken.set(d, it);
        prev = d;
        placed = true;
        break;
      }
    }
    if (!placed) {
      it.status = 'unplaced';
      unplaced.push(it);
    }
  }

  for (const it of items) {
    if (it.status === 'moved' && it.day !== null) {
      messages.push(
        `${it.name} déplacé à ${PLAN_DAY_NAMES[it.day]}${it.manual ? ' (ton choix)' : ''}`,
      );
    }
    if (it.manual && it.day !== null && !restOk(it.day, it)) {
      messages.push(
        `Attention : ${it.name} le ${PLAN_DAY_NAMES[it.day]} laisse moins d'un jour de repos aux mêmes muscles.`,
      );
    }
  }
  if (unplaced.length > 0) {
    const names = unplaced.map((i) => i.name).join(', ');
    messages.push(
      unplaced.length === 1
        ? `Semaine trop entamée : plus de jour libre pour ${names} sans enchaîner les mêmes muscles. Mieux vaut la sauter, la semaine prochaine repart normalement.`
        : `Semaine trop entamée : plus de jour libre pour ${names} sans enchaîner les mêmes muscles. Mieux vaut les sauter, la semaine prochaine repart normalement.`,
    );
  }

  const days: PlanDay[] = SHORT.map((short, day) => ({
    day,
    short,
    name: PLAN_DAY_NAMES[day]!,
    isToday: day === today,
    isPast: day < today,
    unavailable: unavailable.has(day),
    item: taken.get(day) ?? null,
  }));
  const todayItem = taken.get(today);
  return {
    items,
    days,
    messages,
    today: todayItem && todayItem.status !== 'done' ? todayItem : null,
    doneCount: items.filter((i) => i.status === 'done').length,
    total: items.length,
  };
}

/** Jours où l'on peut déplacer une séance : aujourd'hui (ou demain si déjà entraîné) → dimanche, libres. */
export function moveTargets(plan: WeekPlan, key: string, today: number): number[] {
  const trainedToday = plan.items.some((i) => i.status === 'done' && i.day === today);
  const from = today + (trainedToday ? 1 : 0);
  return plan.days
    .filter(
      (d) =>
        d.day >= from &&
        !d.unavailable &&
        (!d.item || d.item.key === key || d.item.status !== 'done'),
    )
    .map((d) => d.day);
}

// ─── Sources : découpage hebdomadaire / programme du catalogue ────────────────

/** Jour d'un découpage (forme de ProgramDay, 0 = dimanche). */
export interface SplitDayLike {
  dayOfWeek: number;
  focus: string;
  muscleGroups: readonly string[];
  restDay: boolean;
}

/** Découpage (Push/Pull/Legs…) → séances de la semaine, du lundi au dimanche. */
export function splitPlanSessions(schedule: readonly SplitDayLike[]): PlanSession[] {
  return schedule
    .filter((d) => !d.restDay)
    .map((d) => ({
      key: `d${d.dayOfWeek}`,
      name: d.focus,
      muscles: d.muscleGroups.length > 0 ? d.muscleGroups : [d.focus],
      day: mondayIndex(d.dayOfWeek),
    }))
    .sort((a, b) => a.day - b.day);
}

/** Jours par défaut quand un programme ne fixe que le nombre de séances. */
const DEFAULT_DAYS: Record<number, number[]> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
};

export function defaultTrainingDays(count: number): number[] {
  return DEFAULT_DAYS[Math.max(1, Math.min(7, Math.round(count)))] ?? [];
}

/** Muscles sollicités par les mouvements de référence du catalogue. */
const LIFT_MUSCLES: Record<string, string[]> = {
  squat: ['quadriceps', 'fessiers', 'lombaires'],
  deadlift: ['ischio', 'fessiers', 'lombaires', 'dos'],
  bench: ['pectoraux', 'triceps', 'épaules'],
  overhead_press: ['épaules', 'triceps'],
  row: ['dos', 'biceps'],
};

/** Semaine numérotée du catalogue (5/3/1, GZCLP…) → séances, jours répartis. */
export function catalogPlanSessions(week: {
  sessions: readonly { name: string; exercises: readonly { liftRef: string }[] }[];
}): PlanSession[] {
  const days = defaultTrainingDays(week.sessions.length);
  return week.sessions.slice(0, 7).map((s, i) => ({
    key: `s${i}`,
    name: s.name,
    muscles: [...new Set(s.exercises.flatMap((e) => LIFT_MUSCLES[e.liftRef] ?? [e.liftRef]))],
    day: days[i] ?? i,
  }));
}
