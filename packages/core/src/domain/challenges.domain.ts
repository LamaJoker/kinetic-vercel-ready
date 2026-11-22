/**
 * Défis hebdomadaires et mensuels : « 12 séances ce mois-ci », « 100 tractions
 * cette semaine », « 50 t de tonnage ce mois », « 7 check-ins d'affilée »,
 * « 2 L d'eau 5 jours »…
 *
 *  - automatiques : choisis par l'app pour chaque période d'après les 4 semaines
 *    qui PRÉCÈDENT son début (donc stables pendant toute la période) ;
 *  - proposés : liste adaptée au niveau, acceptés d'une touche ;
 *  - personnels : métrique, exercice, cible et période au choix (3 par période).
 *
 * Périodes en jours LOCAUX : semaine du lundi au dimanche (clé = lundi
 * « AAAA-MM-JJ »), mois civil (clé « AAAA-MM »). Seules les séries de travail
 * comptent (échauffements exclus). La récompense (XP) est accordée une seule
 * fois par défi : clé d'idempotence `challengeAwardKey`.
 *
 * Pur — aucune dépendance d'E/S.
 */
import { isWarmupSet } from './workout-sets.domain.js';

export type ChallengeMetric =
  | 'sessions'
  | 'tonnage'
  | 'sets'
  | 'reps'
  | 'minutes'
  | 'checkinStreak'
  | 'waterDays';
export type ChallengePeriod = 'week' | 'month';
export type ChallengeOrigin = 'auto' | 'suggested' | 'custom';
export type ChallengeState = 'upcoming' | 'active' | 'done' | 'failed';

export interface ChallengeDef {
  id: string;
  metric: ChallengeMetric;
  period: ChallengePeriod;
  /** Lundi « AAAA-MM-JJ » (semaine) ou « AAAA-MM » (mois). */
  periodKey: string;
  target: number;
  origin: ChallengeOrigin;
  /** Métrique « reps » : exercice compté (nom gardé pour l'affichage). */
  exerciseId?: string;
  exerciseName?: string;
  /** Métrique « waterDays » : seuil d'eau par jour (ml). */
  waterMl?: number;
}

export interface ChallengeSession {
  startedAt: string;
  endedAt?: string;
  durationMin?: number;
  entries: ReadonlyArray<{
    exerciseId: string;
    sets: ReadonlyArray<{ reps: number; weightKg: number; kind?: string }>;
  }>;
}

export interface ChallengeData {
  sessions: readonly ChallengeSession[];
  /** Jours locaux qui ont un check-in du matin. */
  checkinDays?: readonly string[];
  /** Eau bue par jour (ml par verre). */
  water?: Readonly<Record<string, readonly number[]>> | null;
}

export interface ChallengeProgress {
  def: ChallengeDef;
  value: number;
  /** 0 à 1. */
  ratio: number;
  state: ChallengeState;
  /** Jours restants, aujourd'hui compris (0 si la période est finie). */
  daysLeft: number;
  title: string;
  emoji: string;
  /** « 8 / 12 séances » */
  progressLabel: string;
  /** « Plus que 4 séances · 9 j » */
  statusLabel: string;
  xp: number;
}

/** Défi réussi, gardé pour les médailles et le bilan. */
export interface CompletedChallenge {
  id: string;
  title: string;
  emoji: string;
  metric: ChallengeMetric;
  period: ChallengePeriod;
  periodKey: string;
  completedAt: string;
  xp: number;
}

/** Stocké sous STORAGE_KEYS.CHALLENGES. */
export interface ChallengeStore {
  /** Défis proposés acceptés et défis personnels. */
  accepted: ChallengeDef[];
  /** Défis réussis (récompense déjà accordée). */
  completed: CompletedChallenge[];
}

export const CHALLENGE_XP: Readonly<Record<ChallengePeriod, number>> = { week: 25, month: 50 };
/** Défis personnels : récompense réduite (cible choisie par l'utilisateur). */
export const CUSTOM_CHALLENGE_XP: Readonly<Record<ChallengePeriod, number>> = {
  week: 10,
  month: 20,
};
export const MAX_CUSTOM_PER_PERIOD = 3;

export const CHALLENGE_EMOJI: Readonly<Record<ChallengeMetric, string>> = {
  sessions: '🏋️',
  tonnage: '🐘',
  sets: '🔁',
  reps: '💪',
  minutes: '⏱️',
  checkinStreak: '☀️',
  waterDays: '💧',
};

/** Bornes des cibles personnelles (par période d'un mois ; ÷ 4 pour une semaine). */
const TARGET_BOUNDS: Readonly<Record<ChallengeMetric, readonly [number, number]>> = {
  sessions: [1, 31],
  tonnage: [500, 1_000_000],
  sets: [5, 1500],
  reps: [10, 20_000],
  minutes: [30, 6000],
  checkinStreak: [2, 31],
  waterDays: [1, 31],
};

// ─── Jours locaux ────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** Jour local « AAAA-MM-JJ ». */
export function dayOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Jour local d'un horodatage ISO ('' si invalide). */
export function isoDayOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dayOf(new Date(t)) : '';
}

/** Midi local du jour (évite les surprises des changements d'heure). */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
}

export function addDayKey(key: string, n: number): string {
  const d = parseDayKey(key);
  d.setDate(d.getDate() + n);
  return dayOf(d);
}

/** Écart en jours entre deux jours locaux (b − a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseDayKey(b).getTime() - parseDayKey(a).getTime()) / 86_400_000);
}

/** Clé de la période qui contient `now`. */
export function periodKeyOf(period: ChallengePeriod, now: Date): string {
  if (period === 'month') return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayOf(d);
}

/** Premier et dernier jour (inclus) d'une période. */
export function periodRange(period: ChallengePeriod, key: string): { start: string; end: string } {
  if (period === 'week') return { start: key, end: addDayKey(key, 6) };
  const [y, m] = key.split('-').map(Number);
  const last = new Date(y ?? 1970, m ?? 1, 0, 12).getDate();
  return { start: `${key}-01`, end: `${key}-${pad(last)}` };
}

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];

/**
 * « cette semaine », « ce mois-ci » ; sinon « semaine du 16 nov. », « en octobre ».
 * `now` null : toujours la forme datée (« en novembre 2026 »), pour l'historique.
 */
export function periodPhrase(period: ChallengePeriod, key: string, now: Date | null): string {
  const current = !!now && periodKeyOf(period, now) === key;
  if (period === 'week') {
    if (current) return 'cette semaine';
    const d = parseDayKey(key);
    return `semaine du ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  }
  if (current) return 'ce mois-ci';
  const [y, m] = key.split('-').map(Number);
  const month = MONTHS[(m ?? 1) - 1]!;
  return now && y === now.getFullYear() ? `en ${month}` : `en ${month} ${y}`;
}

// ─── Mesure ──────────────────────────────────────────────────────────────────

function sessionMinutes(s: ChallengeSession): number {
  if (s.durationMin && s.durationMin > 0) return s.durationMin;
  if (s.endedAt) {
    const min = (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000;
    if (min > 0 && min < 24 * 60) return Math.round(min);
  }
  return 0;
}

/** Plus longue suite de jours consécutifs parmi `days` (triés ou non, doublons tolérés). */
export function longestDayRun(days: Iterable<string>): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev = '';
  for (const d of sorted) {
    run = prev && dayDiff(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/** Valeur atteinte par un défi sur sa période (jusqu'à aujourd'hui). */
export function measureChallenge(def: ChallengeDef, data: ChallengeData): number {
  const { start, end } = periodRange(def.period, def.periodKey);
  const inside = (day: string): boolean => day >= start && day <= end;

  if (def.metric === 'checkinStreak') {
    return longestDayRun((data.checkinDays ?? []).filter(inside));
  }
  if (def.metric === 'waterDays') {
    const goal = def.waterMl && def.waterMl > 0 ? def.waterMl : 2000;
    return Object.entries(data.water ?? {}).filter(
      ([day, glasses]) =>
        inside(day) &&
        Array.isArray(glasses) &&
        glasses.reduce((a, ml) => a + (Number(ml) || 0), 0) >= goal,
    ).length;
  }

  let value = 0;
  for (const s of data.sessions) {
    if (!inside(isoDayOf(s.startedAt))) continue;
    if (def.metric === 'sessions') value += 1;
    else if (def.metric === 'minutes') value += sessionMinutes(s);
    else {
      for (const e of s.entries) {
        if (def.metric === 'reps' && e.exerciseId !== def.exerciseId) continue;
        for (const set of e.sets) {
          if (isWarmupSet(set)) continue;
          const reps = Number(set.reps) || 0;
          if (def.metric === 'sets') value += 1;
          else if (def.metric === 'reps') value += reps;
          else value += reps * (Number(set.weightKg) || 0);
        }
      }
    }
  }
  return Math.round(value);
}

// ─── Libellés ────────────────────────────────────────────────────────────────

const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: digits }).replace(/[\u202f\u00a0]/g, ' ');

/** « 12,5 t », « 800 kg ». */
export function formatTons(kg: number): string {
  return kg >= 1000 ? `${fmt(kg / 1000, 1)} t` : `${fmt(kg)} kg`;
}

/** « 2 L », « 1,5 L ». */
export function formatLiters(ml: number): string {
  return `${fmt(ml / 1000, 2)} L`;
}

const s = (n: number): string => (n > 1 ? 's' : '');

/** Valeur dans l'unité du défi : « 12 séances », « 12,5 t », « 100 tractions ». */
export function challengeAmount(def: ChallengeDef, n: number): string {
  switch (def.metric) {
    case 'sessions':
      return `${fmt(n)} séance${s(n)}`;
    case 'tonnage':
      return formatTons(n);
    case 'sets':
      return `${fmt(n)} série${s(n)}`;
    case 'reps':
      return `${fmt(n)} ${(def.exerciseName || 'répétitions').toLowerCase()}`;
    case 'minutes':
      return n >= 120 && n % 60 === 0 ? `${fmt(n / 60)} h` : `${fmt(n)} min`;
    case 'checkinStreak':
      return `${fmt(n)} check-in${s(n)}`;
    case 'waterDays':
      return `${fmt(n)} jour${s(n)}`;
  }
}

/** « 12 séances ce mois-ci », « 7 check-ins d'affilée », « 2 L d'eau 5 jours cette semaine ». */
export function challengeTitle(def: ChallengeDef, now: Date | null): string {
  const when = periodPhrase(def.period, def.periodKey, now);
  const t = def.target;
  switch (def.metric) {
    case 'tonnage':
      return `${formatTons(t)} de tonnage ${when}`;
    case 'minutes':
      return `${challengeAmount(def, t)} d'entraînement ${when}`;
    case 'checkinStreak':
      return `${fmt(t)} check-ins d'affilée ${when}`;
    case 'waterDays':
      return `${formatLiters(def.waterMl ?? 2000)} d'eau ${fmt(t)} jour${s(t)} ${when}`;
    default:
      return `${challengeAmount(def, t)} ${when}`;
  }
}

export function challengeXp(def: Pick<ChallengeDef, 'origin' | 'period'>): number {
  return (def.origin === 'custom' ? CUSTOM_CHALLENGE_XP : CHALLENGE_XP)[def.period];
}

/** Clé d'idempotence de la récompense (award-xp). */
export function challengeAwardKey(def: Pick<ChallengeDef, 'id'>): string {
  return `challenge:${def.id}`;
}

/** Progression, état et libellés d'un défi à la date `now`. */
export function evaluateChallenge(
  def: ChallengeDef,
  data: ChallengeData,
  now: Date,
): ChallengeProgress {
  const today = dayOf(now);
  const { start, end } = periodRange(def.period, def.periodKey);
  const value = today < start ? 0 : measureChallenge(def, data);
  const target = Math.max(1, def.target);
  const ratio = Math.max(0, Math.min(1, value / target));
  const state: ChallengeState =
    value >= target ? 'done' : today < start ? 'upcoming' : today > end ? 'failed' : 'active';
  const daysLeft = today > end ? 0 : dayDiff(today < start ? start : today, end) + 1;
  const left = target - value;
  let statusLabel: string;
  if (state === 'done') statusLabel = 'Réussi !';
  else if (state === 'failed') statusLabel = ratio >= 0.8 ? 'Raté de peu' : 'Terminé';
  else if (state === 'upcoming') statusLabel = 'Commence bientôt';
  else {
    const remaining =
      def.metric === 'checkinStreak'
        ? `Série record : ${fmt(value)}`
        : `Plus que ${challengeAmount(def, left)}`;
    statusLabel = `${remaining} · ${daysLeft} j`;
  }
  return {
    def,
    value,
    ratio,
    state,
    daysLeft,
    title: challengeTitle(def, now),
    emoji: CHALLENGE_EMOJI[def.metric],
    progressLabel:
      def.metric === 'tonnage'
        ? `${formatTons(value)} / ${formatTons(target)}`
        : `${fmt(value)} / ${challengeAmount(def, target)}`,
    statusLabel,
    xp: challengeXp(def),
  };
}

/** Défi en cours le plus proche de la réussite (accueil) ; null s'il n'y en a pas. */
export function closestChallenge(list: readonly ChallengeProgress[]): ChallengeProgress | null {
  let best: ChallengeProgress | null = null;
  for (const p of list) {
    if (p.state !== 'active') continue;
    if (!best || p.ratio > best.ratio || (p.ratio === best.ratio && p.daysLeft < best.daysLeft))
      best = p;
  }
  return best;
}

// ─── Niveau de l'utilisateur et défis automatiques / proposés ────────────────

export interface ChallengeBaseline {
  /** Semaines (sur les 4) avec au moins une séance. */
  activeWeeks: number;
  sessionsPerWeek: number;
  tonnagePerWeek: number;
  setsPerWeek: number;
  minutesPerWeek: number;
  /** Exercice le plus fait en répétitions (poids du corps d'abord) et ses reps / semaine. */
  repsExercise: { id: string; perWeek: number } | null;
}

/** Niveau sur les 28 jours qui précèdent `beforeDay` (exclu). */
export function challengeBaseline(data: ChallengeData, beforeDay: string): ChallengeBaseline {
  const start = addDayKey(beforeDay, -28);
  const weeks = new Set<number>();
  let sessions = 0;
  let tonnage = 0;
  let sets = 0;
  let minutes = 0;
  const reps = new Map<string, { reps: number; bodyweight: boolean }>();
  for (const sess of data.sessions) {
    const day = isoDayOf(sess.startedAt);
    if (!day || day < start || day >= beforeDay) continue;
    sessions += 1;
    minutes += sessionMinutes(sess);
    weeks.add(Math.floor(dayDiff(start, day) / 7));
    for (const e of sess.entries) {
      for (const set of e.sets) {
        if (isWarmupSet(set)) continue;
        const r = Number(set.reps) || 0;
        const w = Number(set.weightKg) || 0;
        sets += 1;
        tonnage += r * w;
        if (r > 0) {
          const cur = reps.get(e.exerciseId) ?? { reps: 0, bodyweight: true };
          cur.reps += r;
          if (w > 0) cur.bodyweight = false;
          reps.set(e.exerciseId, cur);
        }
      }
    }
  }
  const ranked = [...reps.entries()].sort(
    (a, b) =>
      Number(b[1].bodyweight) - Number(a[1].bodyweight) ||
      b[1].reps - a[1].reps ||
      a[0].localeCompare(b[0]),
  );
  const top = ranked[0];
  return {
    activeWeeks: weeks.size,
    sessionsPerWeek: sessions / 4,
    tonnagePerWeek: tonnage / 4,
    setsPerWeek: sets / 4,
    minutesPerWeek: minutes / 4,
    repsExercise: top ? { id: top[0], perWeek: top[1].reps / 4 } : null,
  };
}

/** Arrondi « rond » au pas `step`, au moins `min`. */
export function niceTarget(x: number, step: number, min: number): number {
  return Math.max(min, Math.round(x / step) * step);
}

function weeksIn(period: ChallengePeriod, key: string): number {
  if (period === 'week') return 1;
  const { start, end } = periodRange(period, key);
  return (dayDiff(start, end) + 1) / 7;
}

/** Un peu plus que d'habitude (+10 %), sans être hors de portée. */
const STRETCH = 1.1;

interface Candidate {
  metric: ChallengeMetric;
  period: ChallengePeriod;
  target: number;
  exerciseId?: string;
  waterMl?: number;
}

function candidates(
  b: ChallengeBaseline,
  period: ChallengePeriod,
  key: string,
  waterGoalMl: number,
): Candidate[] {
  const w = weeksIn(period, key);
  const out: Candidate[] = [];
  const beginner = b.activeWeeks < 2;
  const perWeek = beginner ? 2 : Math.max(2, b.sessionsPerWeek);
  out.push({
    metric: 'sessions',
    period,
    target:
      period === 'week'
        ? Math.min(7, Math.round(perWeek) + (beginner ? 0 : 1))
        : Math.min(28, Math.max(4, Math.round(perWeek * w * STRETCH))),
  });
  if (b.tonnagePerWeek > 0) {
    out.push({
      metric: 'tonnage',
      period,
      target: niceTarget(b.tonnagePerWeek * w * STRETCH, period === 'week' ? 1000 : 5000, 1000),
    });
  }
  if (b.repsExercise && b.repsExercise.perWeek >= 5) {
    out.push({
      metric: 'reps',
      period,
      exerciseId: b.repsExercise.id,
      target: niceTarget(b.repsExercise.perWeek * w * 1.15, 10, 20),
    });
  }
  out.push({
    metric: 'sets',
    period,
    target: niceTarget(Math.max(b.setsPerWeek, 10) * w * STRETCH, 5, 10),
  });
  if (b.minutesPerWeek > 0) {
    out.push({
      metric: 'minutes',
      period,
      target: niceTarget(b.minutesPerWeek * w * STRETCH, 30, 60),
    });
  }
  out.push({ metric: 'checkinStreak', period, target: period === 'week' ? 5 : 7 });
  out.push({
    metric: 'waterDays',
    period,
    target: period === 'week' ? 5 : 20,
    waterMl: waterGoalMl,
  });
  return out;
}

const sig = (c: Pick<ChallengeDef, 'metric' | 'period' | 'periodKey' | 'exerciseId'>): string =>
  `${c.period}:${c.periodKey}:${c.metric}:${c.exerciseId ?? ''}`;

function toDef(
  c: Candidate,
  key: string,
  origin: ChallengeOrigin,
  nameOf: (id: string) => string,
): ChallengeDef {
  return {
    id: `${origin === 'auto' ? 'auto' : 'sugg'}:${sig({ ...c, periodKey: key })}`,
    metric: c.metric,
    period: c.period,
    periodKey: key,
    target: c.target,
    origin,
    ...(c.exerciseId ? { exerciseId: c.exerciseId, exerciseName: nameOf(c.exerciseId) } : {}),
    ...(c.waterMl ? { waterMl: c.waterMl } : {}),
  };
}

export interface ChallengeContext {
  data: ChallengeData;
  now: Date;
  nameOf: (exerciseId: string) => string;
  /** Objectif d'eau quotidien de l'utilisateur (ml). */
  waterGoalMl?: number;
}

/**
 * Défis automatiques de la semaine et du mois en cours : un défi d'exercice
 * (ou de séances) pour la semaine, séances + tonnage (ou séries) pour le mois.
 */
export function autoChallenges(ctx: ChallengeContext): ChallengeDef[] {
  const out: ChallengeDef[] = [];
  const water = ctx.waterGoalMl ?? 2000;
  for (const period of ['week', 'month'] as const) {
    const key = periodKeyOf(period, ctx.now);
    const b = challengeBaseline(ctx.data, periodRange(period, key).start);
    const list = candidates(b, period, key, water);
    const pick = (m: ChallengeMetric): Candidate | undefined => list.find((c) => c.metric === m);
    const chosen =
      period === 'week'
        ? [pick('reps') ?? pick('sessions')]
        : [pick('sessions'), pick('tonnage') ?? pick('sets')];
    for (const c of chosen) if (c) out.push(toDef(c, key, 'auto', ctx.nameOf));
  }
  return out;
}

/**
 * Défis proposés (à accepter) pour la semaine et le mois en cours, sans ceux
 * déjà en place (même métrique, période et exercice).
 */
export function suggestedChallenges(
  ctx: ChallengeContext,
  existing: readonly ChallengeDef[],
  limit = 4,
): ChallengeDef[] {
  const taken = new Set(existing.map(sig));
  const water = ctx.waterGoalMl ?? 2000;
  const out: ChallengeDef[] = [];
  // Ordre : variété d'abord (check-ins, eau), puis volume.
  const order: ChallengeMetric[] = [
    'checkinStreak',
    'waterDays',
    'sessions',
    'reps',
    'minutes',
    'tonnage',
    'sets',
  ];
  const all: ChallengeDef[] = [];
  for (const period of ['week', 'month'] as const) {
    const key = periodKeyOf(period, ctx.now);
    const b = challengeBaseline(ctx.data, periodRange(period, key).start);
    for (const c of candidates(b, period, key, water))
      all.push(toDef(c, key, 'suggested', ctx.nameOf));
  }
  all.sort((a, b) => order.indexOf(a.metric) - order.indexOf(b.metric));
  const metricsUsed = new Set<string>();
  for (const d of all) {
    if (taken.has(sig(d)) || metricsUsed.has(d.metric)) continue;
    // Un seul défi d'une même métrique dans la liste (semaine OU mois).
    if (d.metric === 'checkinStreak' && d.period === 'week') continue;
    if (d.metric === 'waterDays' && d.period === 'month') continue;
    metricsUsed.add(d.metric);
    out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Défis personnels ────────────────────────────────────────────────────────

export interface CustomChallengeInput {
  metric: ChallengeMetric;
  period: ChallengePeriod;
  target: number;
  exerciseId?: string;
  exerciseName?: string;
  waterMl?: number;
}

/** Bornes de la cible d'un défi personnel pour une période. */
export function customTargetBounds(
  metric: ChallengeMetric,
  period: ChallengePeriod,
): { min: number; max: number } {
  const [min, max] = TARGET_BOUNDS[metric];
  if (period === 'month') return { min, max };
  const daily = metric === 'checkinStreak' || metric === 'waterDays' || metric === 'sessions';
  return { min, max: daily ? 7 : Math.ceil(max / 4) };
}

/** Valide et construit un défi personnel ; `error` en français sinon. */
export function createCustomChallenge(
  input: CustomChallengeInput,
  now: Date,
  existing: readonly ChallengeDef[],
  id: string,
): { def: ChallengeDef } | { error: string } {
  const key = periodKeyOf(input.period, now);
  const target = Math.round(Number(input.target));
  const { min, max } = customTargetBounds(input.metric, input.period);
  if (!Number.isFinite(target) || target < min || target > max) {
    const unit = input.metric === 'tonnage' ? ' kg' : '';
    return { error: `Choisis une cible entre ${fmt(min)} et ${fmt(max)}${unit}.` };
  }
  if (input.metric === 'reps' && !input.exerciseId) return { error: 'Choisis un exercice.' };
  const sameKey = existing.filter(
    (d) => d.origin === 'custom' && d.period === input.period && d.periodKey === key,
  );
  if (sameKey.length >= MAX_CUSTOM_PER_PERIOD) {
    return {
      error: `${MAX_CUSTOM_PER_PERIOD} défis personnels au plus ${input.period === 'week' ? 'par semaine' : 'par mois'}.`,
    };
  }
  return {
    def: {
      id: `custom:${id}`,
      metric: input.metric,
      period: input.period,
      periodKey: key,
      target,
      origin: 'custom',
      ...(input.metric === 'reps' && input.exerciseId
        ? { exerciseId: input.exerciseId, exerciseName: input.exerciseName ?? input.exerciseId }
        : {}),
      ...(input.metric === 'waterDays'
        ? { waterMl: input.waterMl && input.waterMl > 0 ? input.waterMl : 2000 }
        : {}),
    },
  };
}

// ─── Stockage et récompense ──────────────────────────────────────────────────

const METRICS: ReadonlySet<string> = /* @__PURE__ */ new Set(
  /* @__PURE__ */ Object.keys(CHALLENGE_EMOJI),
);

function validDef(raw: unknown): raw is ChallengeDef {
  const d = raw as ChallengeDef | null;
  return (
    !!d &&
    typeof d.id === 'string' &&
    METRICS.has(d.metric) &&
    (d.period === 'week' || d.period === 'month') &&
    typeof d.periodKey === 'string' &&
    Number.isFinite(d.target) &&
    d.target > 0
  );
}

export function normalizeChallengeStore(raw: unknown): ChallengeStore {
  const r = (raw ?? {}) as Partial<ChallengeStore>;
  return {
    accepted: Array.isArray(r.accepted) ? r.accepted.filter(validDef) : [],
    completed: Array.isArray(r.completed)
      ? r.completed.filter(
          (c): c is CompletedChallenge =>
            !!c && typeof c.id === 'string' && typeof c.completedAt === 'string',
        )
      : [],
  };
}

/**
 * Défis réussis pas encore enregistrés : ajoutés au magasin (sans doublon).
 * La récompense de chacun est ensuite accordée avec `challengeAwardKey`.
 */
export function recordCompleted(
  store: ChallengeStore,
  progress: readonly ChallengeProgress[],
  nowIso: string,
): { store: ChallengeStore; newly: CompletedChallenge[] } {
  const known = new Set(store.completed.map((c) => c.id));
  const newly: CompletedChallenge[] = [];
  for (const p of progress) {
    if (p.state !== 'done' || known.has(p.def.id)) continue;
    known.add(p.def.id);
    newly.push({
      id: p.def.id,
      title: challengeTitle(p.def, null),
      emoji: p.emoji,
      metric: p.def.metric,
      period: p.def.period,
      periodKey: p.def.periodKey,
      completedAt: nowIso,
      xp: p.xp,
    });
  }
  if (!newly.length) return { store, newly };
  return { store: { ...store, completed: [...store.completed, ...newly] }, newly };
}

/** Défis en cours : automatiques + acceptés / personnels des périodes en cours. */
export function activeDefs(ctx: ChallengeContext, store: ChallengeStore): ChallengeDef[] {
  const auto = autoChallenges(ctx);
  const ids = new Set(auto.map((d) => d.id));
  const keep = (d: ChallengeDef): boolean =>
    periodKeyOf(d.period, ctx.now) === d.periodKey && !ids.has(d.id);
  return [...auto, ...store.accepted.filter(keep)];
}

/** Retire les défis acceptés dont la période est finie depuis plus de 60 jours. */
export function pruneAccepted(store: ChallengeStore, now: Date): ChallengeStore {
  const limit = addDayKey(dayOf(now), -60);
  const accepted = store.accepted.filter((d) => periodRange(d.period, d.periodKey).end >= limit);
  return accepted.length === store.accepted.length ? store : { ...store, accepted };
}
