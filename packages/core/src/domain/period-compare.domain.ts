/**
 * Comparer deux périodes (Progression › Comparer) : séances, tonnage, séries,
 * durée moyenne, records, poids de corps moyen, régularité, top exercices et
 * groupes musculaires, avec l'écart en %.
 *
 * Les périodes sont des plages de jours LOCAUX inclusives (« AAAA-MM-JJ ») :
 * une séance de 23 h 30 compte pour le jour où elle a eu lieu sur l'appareil.
 * Seules les séries de travail comptent (échauffements exclus).
 *
 * Pur — aucune dépendance d'E/S.
 */
import { isWarmupSet } from './workout-sets.domain.js';
import { e1rm } from './progression.domain.js';

export interface DayRange {
  /** Premier jour inclus (AAAA-MM-JJ, local). */
  start: string;
  /** Dernier jour inclus (AAAA-MM-JJ, local). */
  end: string;
}

export type ComparePreset = 'month' | 'year' | '4w' | 'custom';

export interface CompareSet {
  reps: number;
  weightKg: number;
  kind?: 'work' | 'warmup';
}

export interface CompareSession {
  startedAt: string;
  endedAt?: string;
  durationMin?: number;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly CompareSet[] }>;
}

export interface CompareInput {
  sessions: readonly CompareSession[];
  /** Muscles par exercice (le premier = principal). */
  musclesByExercise?: ReadonlyMap<string, readonly string[]>;
  bodyweight?: ReadonlyArray<{ date: string; weight: number }>;
}

export interface PeriodStats {
  sessions: number;
  tonnageKg: number;
  sets: number;
  /** Durée moyenne (min) des séances qui en ont une ; 0 sinon. */
  avgDurationMin: number;
  /** Records e1RM battus pendant la période (premier essai d'un exercice exclu). */
  records: number;
  /** Poids de corps moyen (kg, 0,1) ; null sans pesée. */
  avgBodyweightKg: number | null;
  trainingDays: number;
  /** Séances par semaine (0,1). */
  perWeek: number;
  /** Tonnage par exercice. */
  exercises: Map<string, { tonnageKg: number; sets: number }>;
  /** Séries par groupe musculaire (principal = 1, secondaires = 0,5). */
  muscles: Map<string, number>;
}

export type CompareTrend = 'up' | 'down' | 'flat';
/** good = turquoise, bad = corail, neutral = gris (poids de corps, durée). */
export type CompareTone = 'good' | 'bad' | 'neutral';

export interface MetricDelta {
  key: string;
  label: string;
  unit: string;
  a: number | null;
  b: number | null;
  /** Écart en % de A par rapport à B (arrondi) ; null si B vaut 0 ou manque. */
  pct: number | null;
  trend: CompareTrend;
  tone: CompareTone;
}

export interface RowDelta {
  id: string;
  a: number;
  b: number;
  pct: number | null;
  trend: CompareTrend;
}

export interface PeriodComparison {
  a: PeriodStats;
  b: PeriodStats;
  metrics: MetricDelta[];
  topExercises: RowDelta[];
  muscles: RowDelta[];
}

// ─── Dates locales ───────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** Jour local « AAAA-MM-JJ » d'une date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Jour local d'un horodatage ISO ('' si invalide). */
export function localDayOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dayKey(new Date(t)) : '';
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12);
}

function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** Nombre de jours d'une plage (inclusive), au moins 1. */
export function rangeDays(r: DayRange): number {
  const ms = parseDay(r.end).getTime() - parseDay(r.start).getTime();
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Même jour du mois, borné à la fin du mois visé (31 mars → 28/29 févr.). */
function sameDayIn(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0, 12).getDate();
  return new Date(year, month, Math.min(day, last), 12);
}

/**
 * Plages d'un préréglage, « à date » pour rester équitable :
 *   month : du 1er à aujourd'hui vs mêmes jours du mois précédent ;
 *   year  : idem vs même mois l'an dernier ;
 *   4w    : 28 derniers jours vs les 28 précédents.
 */
export function presetRanges(
  preset: Exclude<ComparePreset, 'custom'>,
  now: Date,
): { a: DayRange; b: DayRange } {
  const today = dayKey(now);
  if (preset === '4w') {
    const aStart = addDays(today, -27);
    return {
      a: { start: aStart, end: today },
      b: { start: addDays(aStart, -28), end: addDays(aStart, -1) },
    };
  }
  const y = now.getFullYear();
  const m = now.getMonth();
  const bYear = preset === 'year' ? y - 1 : m === 0 ? y - 1 : y;
  const bMonth = preset === 'year' ? m : (m + 11) % 12;
  return {
    a: { start: dayKey(new Date(y, m, 1, 12)), end: today },
    b: {
      start: dayKey(new Date(bYear, bMonth, 1, 12)),
      end: dayKey(sameDayIn(bYear, bMonth, now.getDate())),
    },
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Plage remise dans l'ordre (début ≤ fin) ; null si une borne manque. */
export function normalizeRange(start: string, end: string): DayRange | null {
  if (!DAY_RE.test(start) || !DAY_RE.test(end)) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

const MONTHS = [
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

/** « 1–21 nov. 2026 », « 28 oct. – 3 nov. 2026 », « 2 déc. 2025 – 5 janv. 2026 ». */
export function formatRange(r: DayRange): string {
  const [ys, ms, ds] = r.start.split('-').map(Number);
  const [ye, me, de] = r.end.split('-').map(Number);
  const mS = MONTHS[ms! - 1]!;
  const mE = MONTHS[me! - 1]!;
  if (r.start === r.end) return `${ds} ${mS} ${ys}`;
  if (ys === ye && ms === me) return `${ds}–${de} ${mE} ${ye}`;
  if (ys === ye) return `${ds} ${mS} – ${de} ${mE} ${ye}`;
  return `${ds} ${mS} ${ys} – ${de} ${mE} ${ye}`;
}

// ─── Agrégation ──────────────────────────────────────────────────────────────

const inRange = (day: string, r: DayRange): boolean => day >= r.start && day <= r.end;

function sessionDuration(s: CompareSession): number {
  if (s.durationMin && s.durationMin > 0) return s.durationMin;
  if (s.endedAt) {
    const min = (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000;
    if (min > 0 && min < 24 * 60) return Math.round(min);
  }
  return 0;
}

/** Statistiques d'une période. */
export function periodStats(input: CompareInput, range: DayRange): PeriodStats {
  const muscles = input.musclesByExercise;
  const ordered = [...input.sessions].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  const best = new Map<string, number>();
  const exercises = new Map<string, { tonnageKg: number; sets: number }>();
  const byMuscle = new Map<string, number>();
  const days = new Set<string>();
  let sessions = 0;
  let tonnage = 0;
  let sets = 0;
  let records = 0;
  let durSum = 0;
  let durN = 0;

  for (const s of ordered) {
    const day = localDayOf(s.startedAt);
    if (day > range.end) break;
    const inside = inRange(day, range);
    if (inside) {
      sessions += 1;
      days.add(day);
      const d = sessionDuration(s);
      if (d > 0) {
        durSum += d;
        durN += 1;
      }
    }
    for (const e of s.entries) {
      let beat = false;
      for (const set of e.sets) {
        if (isWarmupSet(set)) continue;
        const reps = Number(set.reps) || 0;
        const w = Number(set.weightKg) || 0;
        // Records : historique complet jusqu'à la fin de la période (Epley).
        if (reps >= 1 && w > 0) {
          const est = e1rm(w, reps);
          const prev = best.get(e.exerciseId);
          if (prev === undefined || est > prev) {
            if (inside && prev !== undefined) beat = true;
            best.set(e.exerciseId, est);
          }
        }
        if (!inside) continue;
        sets += 1;
        tonnage += reps * w;
        const cur = exercises.get(e.exerciseId) ?? { tonnageKg: 0, sets: 0 };
        cur.tonnageKg += reps * w;
        cur.sets += 1;
        exercises.set(e.exerciseId, cur);
        (muscles?.get(e.exerciseId) ?? []).forEach((m, i) =>
          byMuscle.set(m, (byMuscle.get(m) ?? 0) + (i === 0 ? 1 : 0.5)),
        );
      }
      if (beat) records += 1;
    }
  }

  const weights = (input.bodyweight ?? [])
    .filter(
      (b) => b.weight > 0 && inRange(DAY_RE.test(b.date) ? b.date : localDayOf(b.date), range),
    )
    .map((b) => b.weight);

  return {
    sessions,
    tonnageKg: Math.round(tonnage),
    sets,
    avgDurationMin: durN ? Math.round(durSum / durN) : 0,
    records,
    avgBodyweightKg: weights.length
      ? Math.round((weights.reduce((a, w) => a + w, 0) / weights.length) * 10) / 10
      : null,
    trainingDays: days.size,
    perWeek: Math.round(((sessions * 7) / rangeDays(range)) * 10) / 10,
    exercises,
    muscles: byMuscle,
  };
}

/** Écart en % de a par rapport à b (arrondi) ; null si b est nul ou absent. */
export function pctChange(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !(b > 0)) return null;
  return Math.round(((a - b) / b) * 100);
}

function trendOf(a: number | null, b: number | null): CompareTrend {
  if (a === null || b === null) return 'flat';
  const eps = Math.max(Math.abs(b) * 0.005, 1e-9);
  return a - b > eps ? 'up' : b - a > eps ? 'down' : 'flat';
}

function metric(
  key: string,
  label: string,
  unit: string,
  a: number | null,
  b: number | null,
  higherIsBetter: boolean,
): MetricDelta {
  const trend = trendOf(a, b);
  const tone: CompareTone =
    !higherIsBetter || trend === 'flat'
      ? 'neutral'
      : (trend === 'up') === higherIsBetter
        ? 'good'
        : 'bad';
  return { key, label, unit, a, b, pct: pctChange(a, b), trend, tone };
}

function rows(a: Map<string, number>, b: Map<string, number>, limit: number): RowDelta[] {
  const ids = new Set([...a.keys(), ...b.keys()]);
  return [...ids]
    .map((id) => {
      const va = Math.round((a.get(id) ?? 0) * 10) / 10;
      const vb = Math.round((b.get(id) ?? 0) * 10) / 10;
      return { id, a: va, b: vb, pct: pctChange(va, vb), trend: trendOf(va, vb) };
    })
    .filter((r) => r.a > 0 || r.b > 0)
    .sort((x, y) => y.a - x.a || y.b - x.b || x.id.localeCompare(y.id))
    .slice(0, limit);
}

/** Compare la période A (actuelle) à la période B (référence). */
export function comparePeriods(
  input: CompareInput,
  rangeA: DayRange,
  rangeB: DayRange,
): PeriodComparison {
  const a = periodStats(input, rangeA);
  const b = periodStats(input, rangeB);
  const tonnage = (s: PeriodStats) =>
    new Map([...s.exercises].map(([id, v]) => [id, v.tonnageKg] as const));
  return {
    a,
    b,
    metrics: [
      metric('sessions', 'Séances', '', a.sessions, b.sessions, true),
      metric('tonnage', 'Tonnage', 'kg', a.tonnageKg, b.tonnageKg, true),
      metric('sets', 'Séries', '', a.sets, b.sets, true),
      metric(
        'duration',
        'Durée moyenne',
        'min',
        a.avgDurationMin || null,
        b.avgDurationMin || null,
        false,
      ),
      metric('records', 'Records', '', a.records, b.records, true),
      metric('perWeek', 'Séances / semaine', '', a.perWeek, b.perWeek, true),
      metric('days', "Jours d'entraînement", '', a.trainingDays, b.trainingDays, true),
      metric(
        'bodyweight',
        'Poids de corps moyen',
        'kg',
        a.avgBodyweightKg,
        b.avgBodyweightKg,
        false,
      ),
    ],
    topExercises: rows(tonnage(a), tonnage(b), 5),
    muscles: rows(a.muscles, b.muscles, 12),
  };
}
