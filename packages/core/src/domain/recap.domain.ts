/**
 * Bilan du mois et de l'année (page « Bilan », façon « Wrapped ») : séances,
 * heures, tonnage (avec une comparaison parlante), records battus, exercice
 * favori, plus longue série de jours, jour préféré, muscle le plus travaillé,
 * progression d'un exercice clé, régularité, forme moyenne et objectifs atteints.
 *
 * Périodes en jours LOCAUX : mois civil (« 2026-11 ») ou année (« 2026 »).
 * Seules les séries de travail comptent (échauffements exclus). Les records
 * comparent à tout l'historique antérieur (premier essai d'un exercice exclu).
 *
 * Pur — aucune dépendance d'E/S.
 */
import { isWarmupSet } from './workout-sets.domain.js';
import { e1rm } from './progression.domain.js';
import { formLevel, formScore, type CheckIn, type FormLevel } from './wellness.domain.js';
import {
  MUSCLE_REGIONS,
  muscleLevel,
  regionWeights,
  type MuscleLevel,
  type MuscleRegion,
} from './muscle-map.domain.js';
import { addDayKey, dayDiff, dayOf, isoDayOf, longestDayRun } from './challenges.domain.js';

export type RecapKind = 'month' | 'year';

export interface RecapPeriod {
  kind: RecapKind;
  /** « 2026-11 » (mois) ou « 2026 » (année). */
  key: string;
}

export interface RecapSession {
  startedAt: string;
  endedAt?: string;
  durationMin?: number;
  entries: ReadonlyArray<{
    exerciseId: string;
    sets: ReadonlyArray<{ reps: number; weightKg: number; kind?: string }>;
  }>;
}

/** Objectif atteint (objectif de force, défi réussi…) à dater dans le bilan. */
export interface RecapMilestone {
  title: string;
  /** Horodatage ISO ou jour « AAAA-MM-JJ ». */
  at: string;
}

export interface RecapInput {
  sessions: readonly RecapSession[];
  musclesOf?: (exerciseId: string) => readonly string[];
  checkins?: Readonly<
    Record<string, Pick<CheckIn, 'sleep' | 'sleepHours' | 'energy' | 'soreness'>>
  >;
  milestones?: readonly RecapMilestone[];
  /** Objectif de séances par semaine (semaines réussies). */
  weeklyTarget?: number;
}

export interface RecapRecord {
  exerciseId: string;
  weightKg: number;
  reps: number;
  e1rm: number;
  /** Gain d'e1RM sur le meilleur d'avant la période (kg, 0,1). */
  gainKg: number;
  day: string;
}

export interface RecapSummary {
  period: RecapPeriod;
  /** « Novembre 2026 », « 2026 ». */
  label: string;
  start: string;
  end: string;
  /** Période pas encore finie (mois ou année en cours). */
  ongoing: boolean;
  empty: boolean;
  sessions: number;
  trainingDays: number;
  minutes: number;
  sets: number;
  tonnageKg: number;
  tonnageCompare: TonnageCompare | null;
  records: RecapRecord[];
  favorite: { exerciseId: string; sessions: number; sets: number } | null;
  longestDayStreak: number;
  weekday: { index: number; label: string; count: number } | null;
  muscles: {
    top: { key: MuscleRegion; label: string; sets: number } | null;
    levels: Partial<Record<MuscleRegion, MuscleLevel>>;
  };
  keyLift: {
    exerciseId: string;
    points: Array<{ day: string; e1rm: number }>;
    startE1rm: number;
    endE1rm: number;
    gainKg: number;
    gainPct: number;
  } | null;
  /** Semaines (lundi–dimanche) de la période avec au moins une séance. */
  activeWeeks: number;
  totalWeeks: number;
  regularityPct: number;
  form: { avg: number; count: number; level: FormLevel } | null;
  milestones: RecapMilestone[];
  weeklyGoalsHit: number;
  /** Écart avec la période précédente (%), null sans référence. */
  vsPrevious: { sessionsPct: number | null; tonnagePct: number | null };
}

// ─── Périodes ────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

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
const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function currentRecapPeriod(kind: RecapKind, now: Date): RecapPeriod {
  return {
    kind,
    key:
      kind === 'year'
        ? String(now.getFullYear())
        : `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
  };
}

/** Période d'un pas avant (−1) ou après (+1). */
export function shiftRecapPeriod(p: RecapPeriod, step: number): RecapPeriod {
  if (p.kind === 'year') return { kind: 'year', key: String(Number(p.key) + step) };
  const [y, m] = p.key.split('-').map(Number);
  const d = new Date(y!, m! - 1 + step, 1, 12);
  return { kind: 'month', key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}` };
}

/** Bilan par défaut : le mois qui vient de se terminer. */
export function defaultRecapPeriod(now: Date): RecapPeriod {
  return shiftRecapPeriod(currentRecapPeriod('month', now), -1);
}

/** Vrai si la période commence après la période en cours (futur). */
export function isFutureRecap(p: RecapPeriod, now: Date): boolean {
  return p.key > currentRecapPeriod(p.kind, now).key;
}

/**
 * Lit « ?periode=2026-11 » ou « 2026 » ; invalide, absent ou futur : le mois
 * qui vient de se terminer.
 */
export function parseRecapPeriod(raw: string | null | undefined, now: Date): RecapPeriod {
  const v = (raw ?? '').trim();
  let p: RecapPeriod | null = null;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) p = { kind: 'month', key: v };
  else if (/^\d{4}$/.test(v) && Number(v) >= 2000) p = { kind: 'year', key: v };
  return p && !isFutureRecap(p, now) ? p : defaultRecapPeriod(now);
}

export function recapRange(p: RecapPeriod): { start: string; end: string } {
  if (p.kind === 'year') return { start: `${p.key}-01-01`, end: `${p.key}-12-31` };
  const [y, m] = p.key.split('-').map(Number);
  return { start: `${p.key}-01`, end: `${p.key}-${pad(new Date(y!, m!, 0, 12).getDate())}` };
}

/** « novembre » (mois) ; « 2026 » (année). */
export function recapMonthName(p: RecapPeriod): string {
  return p.kind === 'year' ? p.key : MONTHS[Number(p.key.slice(5)) - 1]!;
}

/** « Novembre 2026 », « 2026 ». */
export function recapLabel(p: RecapPeriod): string {
  if (p.kind === 'year') return p.key;
  const name = recapMonthName(p);
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${p.key.slice(0, 4)}`;
}

/** « de novembre », « d'octobre », « d'août » ; « 2026 » pour l'année. */
export function recapOf(p: RecapPeriod): string {
  if (p.kind === 'year') return p.key;
  const name = recapMonthName(p);
  return /^[aeiouéè]/.test(name) ? `d'${name}` : `de ${name}`;
}

/**
 * Carte d'accueil « Ton bilan de novembre est prêt » : les 3 premiers jours
 * du mois, s'il y a eu au moins une séance le mois précédent.
 */
export function recapTeaser(
  now: Date,
  sessions: ReadonlyArray<{ startedAt: string }>,
): { period: RecapPeriod; title: string; href: string } | null {
  if (now.getDate() > 3) return null;
  const period = defaultRecapPeriod(now);
  const { start, end } = recapRange(period);
  const any = sessions.some((s) => {
    const d = isoDayOf(s.startedAt);
    return d >= start && d <= end;
  });
  if (!any) return null;
  return {
    period,
    title: `Ton bilan ${recapOf(period)} est prêt`,
    href: `/bilan?periode=${period.key}`,
  };
}

// ─── Tonnage parlant ─────────────────────────────────────────────────────────

export interface TonnageCompare {
  count: number;
  /** « éléphants » (accordé). */
  unit: string;
  emoji: string;
  /** « l'équivalent de 28 éléphants » */
  text: string;
}

const TONNAGE_UNITS: ReadonlyArray<{ kg: number; one: string; many: string; emoji: string }> = [
  { kg: 150_000, one: 'baleine bleue', many: 'baleines bleues', emoji: '🐋' },
  { kg: 6_000, one: 'éléphant', many: 'éléphants', emoji: '🐘' },
  { kg: 1_200, one: 'voiture', many: 'voitures', emoji: '🚗' },
  { kg: 450, one: 'piano à queue', many: 'pianos à queue', emoji: '🎹' },
  { kg: 70, one: 'machine à laver', many: 'machines à laver', emoji: '🧺' },
];

/** La plus grande image qui tient au moins 2 fois (sinon la plus petite). */
export function tonnageComparison(kg: number): TonnageCompare | null {
  if (!(kg >= TONNAGE_UNITS.at(-1)!.kg)) return null;
  const unit = TONNAGE_UNITS.find((u) => kg / u.kg >= 2) ?? TONNAGE_UNITS.at(-1)!;
  const count = Math.round(kg / unit.kg);
  const word = count > 1 ? unit.many : unit.one;
  const n = count.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');
  return { count, unit: word, emoji: unit.emoji, text: `l'équivalent de ${n} ${word}` };
}

// ─── Agrégation ──────────────────────────────────────────────────────────────

function minutesOf(s: RecapSession): number {
  if (s.durationMin && s.durationMin > 0) return s.durationMin;
  if (s.endedAt) {
    const min = (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000;
    if (min > 0 && min < 24 * 60) return Math.round(min);
  }
  return 0;
}

const mondayOf = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number);
  const wd = (new Date(y!, m! - 1, d!, 12).getDay() + 6) % 7;
  return addDayKey(day, -wd);
};

const pct = (a: number, b: number): number | null =>
  b > 0 ? Math.round(((a - b) / b) * 100) : null;

const round1 = (n: number): number => Math.round(n * 10) / 10;

interface Basic {
  sessions: number;
  tonnage: number;
}

function basics(sessions: readonly RecapSession[], start: string, end: string): Basic {
  let n = 0;
  let tonnage = 0;
  for (const s of sessions) {
    const day = isoDayOf(s.startedAt);
    if (day < start || day > end) continue;
    n += 1;
    for (const e of s.entries)
      for (const set of e.sets)
        if (!isWarmupSet(set)) tonnage += (Number(set.reps) || 0) * (Number(set.weightKg) || 0);
  }
  return { sessions: n, tonnage };
}

/** Jour de la semaine le plus fréquent (lundi d'abord en cas d'égalité). */
function favoriteWeekday(counts: readonly number[]): RecapSummary['weekday'] {
  const count = Math.max(...counts);
  const index = counts.indexOf(count);
  return count > 0 ? { index, label: WEEKDAYS[index]!, count } : null;
}

/** Semaines de la période (jusqu'à `lastDay`) et semaines à l'objectif de séances. */
function countWeeks(
  start: string,
  lastDay: string,
  weekCounts: ReadonlyMap<string, number>,
  target: number | undefined,
): { total: number; goalsHit: number } {
  let total = 0;
  let goalsHit = 0;
  for (let mon = mondayOf(start); mon <= lastDay; mon = addDayKey(mon, 7)) {
    total += 1;
    if (target && (weekCounts.get(mon) ?? 0) >= target) goalsHit += 1;
  }
  return { total, goalsHit };
}

/** Paliers de la mini carte (séries / semaine) et muscle le plus travaillé. */
function muscleSummary(
  regions: ReadonlyMap<MuscleRegion, number>,
  weeks: number,
): RecapSummary['muscles'] {
  const levels: Partial<Record<MuscleRegion, MuscleLevel>> = {};
  let top: RecapSummary['muscles']['top'] = null;
  for (const info of MUSCLE_REGIONS) {
    const n = regions.get(info.key) ?? 0;
    levels[info.key] = muscleLevel(n / weeks);
    if (n > 0 && (!top || n > top.sets))
      top = { key: info.key, label: info.label, sets: round1(n) };
  }
  return { top, levels };
}

/** Exercice favori : le plus de séances, puis le plus de séries de travail. */
function favoriteOf(
  exercises: ReadonlyMap<string, { sessions: number; sets: number }>,
): RecapSummary['favorite'] {
  const entry = [...exercises.entries()].sort(
    (a, b) => b[1].sessions - a[1].sessions || b[1].sets - a[1].sets || a[0].localeCompare(b[0]),
  )[0];
  return entry ? { exerciseId: entry[0], ...entry[1] } : null;
}

/**
 * Exercice clé : le favori s'il a au moins 2 séances chargées (la courbe et la
 * carte « favori » parlent du même exercice) ; sinon le plus suivi, puis celui
 * qui a le plus de séries, puis le plus progressé.
 */
function keyLiftOf(
  lift: ReadonlyMap<string, Array<{ day: string; e1rm: number }>>,
  exercises: ReadonlyMap<string, { sets: number }>,
  favoriteId: string | undefined,
): RecapSummary['keyLift'] {
  const setsOf = (id: string): number => exercises.get(id)?.sets ?? 0;
  const gain = (pts: ReadonlyArray<{ e1rm: number }>): number => pts.at(-1)!.e1rm - pts[0]!.e1rm;
  const entry = [...lift.entries()]
    .filter(([, pts]) => pts.length >= 2)
    .sort(
      (a, b) =>
        Number(b[0] === favoriteId) - Number(a[0] === favoriteId) ||
        b[1].length - a[1].length ||
        setsOf(b[0]) - setsOf(a[0]) ||
        gain(b[1]) - gain(a[1]) ||
        a[0].localeCompare(b[0]),
    )[0];
  if (!entry) return null;
  const [exerciseId, points] = entry;
  const startE1rm = points[0]!.e1rm;
  const endE1rm = Math.max(...points.slice(-2).map((p) => p.e1rm));
  return {
    exerciseId,
    points,
    startE1rm,
    endE1rm,
    gainKg: round1(endE1rm - startE1rm),
    gainPct: startE1rm > 0 ? Math.round(((endE1rm - startE1rm) / startE1rm) * 100) : 0,
  };
}

/** Forme moyenne des check-ins de la période ; null sans check-in. */
function formSummary(
  checkins: RecapInput['checkins'],
  start: string,
  end: string,
): RecapSummary['form'] {
  const scores = Object.entries(checkins ?? {})
    .filter(([d]) => d >= start && d <= end)
    .map(([, c]) => formScore(c));
  if (!scores.length) return null;
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { avg, count: scores.length, level: formLevel(avg) };
}

/** Bilan complet d'une période à la date `now`. */
export function buildRecap(input: RecapInput, period: RecapPeriod, now: Date): RecapSummary {
  const { start, end } = recapRange(period);
  const today = dayOf(now);
  const ongoing = today <= end;
  const lastDay = ongoing ? today : end;
  const ordered = [...input.sessions]
    .map((s) => ({ s, day: isoDayOf(s.startedAt) }))
    .filter((x) => x.day && x.day <= end)
    .sort((a, b) => a.s.startedAt.localeCompare(b.s.startedAt));

  const days = new Set<string>();
  const weeks = new Set<string>();
  const weekCounts = new Map<string, number>();
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  const best = new Map<string, number>();
  const records = new Map<string, RecapRecord>();
  const exercises = new Map<string, { sessions: number; sets: number }>();
  const lift = new Map<string, Array<{ day: string; e1rm: number }>>();
  const regions = new Map<MuscleRegion, number>();
  let sessions = 0;
  let minutes = 0;
  let sets = 0;
  let tonnage = 0;

  for (const { s, day } of ordered) {
    const inside = day >= start;
    if (inside) {
      sessions += 1;
      minutes += minutesOf(s);
      days.add(day);
      const monday = mondayOf(day);
      weeks.add(monday);
      weekCounts.set(monday, (weekCounts.get(monday) ?? 0) + 1);
      const [y, m, d] = day.split('-').map(Number);
      weekdayCounts[(new Date(y!, m! - 1, d!, 12).getDay() + 6) % 7]! += 1;
    }
    for (const e of s.entries) {
      let sessionBest = 0;
      let workSets = 0;
      const weights =
        inside && input.musclesOf ? regionWeights(input.musclesOf(e.exerciseId)) : null;
      for (const set of e.sets) {
        if (isWarmupSet(set)) continue;
        const reps = Number(set.reps) || 0;
        const w = Number(set.weightKg) || 0;
        const est = reps >= 1 && w > 0 ? e1rm(w, reps) : 0;
        if (!inside) {
          if (est > (best.get(e.exerciseId) ?? 0)) best.set(e.exerciseId, est);
          continue;
        }
        workSets += 1;
        tonnage += reps * w;
        if (est > sessionBest) sessionBest = est;
        if (weights) for (const [r, wt] of weights) regions.set(r, (regions.get(r) ?? 0) + wt);
        const prior = best.get(e.exerciseId);
        const rec = records.get(e.exerciseId);
        if (est > 0 && prior !== undefined && est > prior && (!rec || est > rec.e1rm)) {
          records.set(e.exerciseId, {
            exerciseId: e.exerciseId,
            weightKg: w,
            reps,
            e1rm: round1(est),
            gainKg: round1(est - prior),
            day,
          });
        }
      }
      if (!inside || workSets === 0) continue;
      sets += workSets;
      const ex = exercises.get(e.exerciseId) ?? { sessions: 0, sets: 0 };
      ex.sessions += 1;
      ex.sets += workSets;
      exercises.set(e.exerciseId, ex);
      if (sessionBest > 0) {
        const pts = lift.get(e.exerciseId) ?? [];
        pts.push({ day, e1rm: round1(sessionBest) });
        lift.set(e.exerciseId, pts);
        // Le meilleur d'avant reste la référence de toute la période.
        if (!best.has(e.exerciseId)) best.set(e.exerciseId, sessionBest);
      }
    }
  }

  const favorite = favoriteOf(exercises);
  const weekStats = countWeeks(start, lastDay, weekCounts, input.weeklyTarget);
  const muscles = muscleSummary(regions, Math.max(1, (dayDiff(start, lastDay) + 1) / 7));
  const form = formSummary(input.checkins, start, end);
  const milestones = (input.milestones ?? [])
    .filter((m) => {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(m.at) ? m.at : isoDayOf(m.at);
      return d >= start && d <= end;
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  const prev = shiftRecapPeriod(period, -1);
  const prevRange = recapRange(prev);
  const before = basics(input.sessions, prevRange.start, prevRange.end);

  return {
    period,
    label: recapLabel(period),
    start,
    end,
    ongoing,
    empty: sessions === 0,
    sessions,
    trainingDays: days.size,
    minutes,
    sets,
    tonnageKg: Math.round(tonnage),
    tonnageCompare: tonnageComparison(tonnage),
    records: [...records.values()].sort(
      (a, b) => b.gainKg - a.gainKg || a.exerciseId.localeCompare(b.exerciseId),
    ),
    favorite,
    longestDayStreak: longestDayRun(days),
    weekday: favoriteWeekday(weekdayCounts),
    muscles,
    keyLift: keyLiftOf(lift, exercises, favorite?.exerciseId),
    activeWeeks: weeks.size,
    totalWeeks: weekStats.total,
    regularityPct: weekStats.total ? Math.round((weeks.size / weekStats.total) * 100) : 0,
    form,
    milestones,
    weeklyGoalsHit: weekStats.goalsHit,
    vsPrevious: {
      sessionsPct: pct(sessions, before.sessions),
      tonnagePct: pct(tonnage, before.tonnage),
    },
  };
}

// ─── Textes ──────────────────────────────────────────────────────────────────

const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('fr-FR', { maximumFractionDigits: digits }).replace(/[\u202f\u00a0]/g, ' ');

/** « 12 h 30 », « 45 min ». */
export function formatRecapHours(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${fmt(h)} h ${pad(r)}` : `${fmt(h)} h`;
}

/** Tonnage en tonnes (≥ 1 t) ou en kg : { value: « 182,4 », unit: « t » }. */
export function recapTonnageParts(kg: number): { value: string; unit: string } {
  return kg >= 1000 ? { value: fmt(kg / 1000, 1), unit: 't' } : { value: fmt(kg), unit: 'kg' };
}

/**
 * « +12 % vs octobre », « −5 % vs 2025 » ; au-delà du double, « ×2,5 vs
 * octobre » (plus parlant que « +1598 % ») ; '' sans référence.
 */
export function recapTrendLabel(pctValue: number | null, period: RecapPeriod): string {
  if (pctValue === null) return '';
  const prev = shiftRecapPeriod(period, -1);
  const ratio = 1 + pctValue / 100;
  if (ratio >= 2) return `×${fmt(ratio, ratio < 10 ? 1 : 0)} vs ${recapMonthName(prev)}`;
  const sign = pctValue > 0 ? '+' : pctValue < 0 ? '−' : '±';
  return `${sign}${Math.abs(pctValue)} % vs ${recapMonthName(prev)}`;
}

export interface RecapShareCard {
  kicker: string;
  title: string;
  tiles: Array<{ label: string; value: string; unit: string }>;
  lines: string[];
}

/** Contenu de l'image à partager (1080 × 1920). */
export function recapShareCard(
  r: RecapSummary,
  nameOf: (exerciseId: string) => string,
): RecapShareCard {
  const t = recapTonnageParts(r.tonnageKg);
  const lines: string[] = [];
  if (r.tonnageCompare) lines.push(`${r.tonnageCompare.emoji} ${cap(r.tonnageCompare.text)}`);
  if (r.records.length)
    lines.push(
      `🏆 ${r.records.length} record${r.records.length > 1 ? 's' : ''} battu${r.records.length > 1 ? 's' : ''}`,
    );
  if (r.favorite) lines.push(`❤️ Exercice favori : ${nameOf(r.favorite.exerciseId)}`);
  if (r.muscles.top) lines.push(`💪 Muscle n° 1 : ${r.muscles.top.label.toLowerCase()}`);
  if (r.keyLift && r.keyLift.gainKg > 0)
    lines.push(`📈 ${nameOf(r.keyLift.exerciseId)} : +${fmt(r.keyLift.gainKg, 1)} kg d'e1RM`);
  if (r.weekday) lines.push(`📅 Jour préféré : le ${r.weekday.label}`);
  return {
    kicker: r.period.kind === 'year' ? 'Mon année' : 'Mon mois',
    title: r.label,
    tiles: [
      { label: 'Séances', value: fmt(r.sessions), unit: '' },
      { label: 'Heures', value: fmt(r.minutes / 60, 1), unit: 'h' },
      { label: 'Tonnage', value: t.value, unit: t.unit },
    ],
    lines: lines.slice(0, 5),
  };
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** « kinetic-bilan-2026-11.png » */
export function recapFileName(p: RecapPeriod): string {
  return `kinetic-bilan-${p.key}.png`;
}
