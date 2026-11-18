/**
 * Calendrier d'entraînement — grille d'un mois (lundi en premier), type de
 * chaque séance (Push / Pull / Jambes / Haut du corps / Full body) et résumé
 * du mois. Pur, sans I/O.
 *
 * Les dates sont regroupées par jour LOCAL (fuseau de l'appareil), comme la
 * heatmap et les objectifs hebdo. Seules les séries de travail comptent dans le
 * tonnage (les échauffements en sont exclus partout).
 */
import { classifyPattern } from './muscle-balance.domain.js';
import { workSetsOf } from './workout-sets.domain.js';

export type SessionKind = 'push' | 'pull' | 'legs' | 'upper' | 'full' | 'other';

export const SESSION_KIND_LABELS: Readonly<Record<SessionKind, string>> = {
  push: 'Push',
  pull: 'Pull',
  legs: 'Jambes',
  upper: 'Haut du corps',
  full: 'Full body',
  other: 'Autre',
};

/** Ordre d'affichage de la légende. */
export const SESSION_KIND_ORDER: readonly SessionKind[] = [
  'push',
  'pull',
  'legs',
  'upper',
  'full',
  'other',
];

export interface CalendarSet {
  weightKg: number;
  reps: number;
  kind?: string | undefined;
}

export interface CalendarSession {
  id: string;
  name: string;
  startedAt: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly CalendarSet[] }>;
}

/** Muscles d'un exercice (catalogue + exercices perso). */
export type MusclesOf = (exerciseId: string) => readonly string[];

export interface CalendarDay {
  /** Date locale « AAAA-MM-JJ ». */
  date: string;
  /** Numéro du jour dans le mois (1-31). */
  day: number;
  /** Faux pour les jours du mois précédent/suivant qui complètent la grille. */
  inMonth: boolean;
  isToday: boolean;
  isFuture: boolean;
  /** Séances du jour, dans l'ordre chronologique. */
  sessionIds: string[];
  /** Type de chaque séance du jour (même ordre que sessionIds). */
  kinds: SessionKind[];
}

export interface MonthSummary {
  sessions: number;
  tonnageKg: number;
  activeDays: number;
  /** Nombre de séances par type (types absents : 0). */
  byKind: Record<SessionKind, number>;
}

export interface MonthCalendar {
  year: number;
  /** 0 = janvier. */
  month: number;
  /** « novembre 2026 ». */
  label: string;
  /** Semaines de 7 jours, lundi → dimanche. */
  weeks: CalendarDay[][];
  summary: MonthSummary;
}

const MONTHS_FR = [
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
] as const;

/** « novembre 2026 » (sans dépendre des données de langue du moteur JS). */
export function monthLabel(year: number, month: number): string {
  return `${MONTHS_FR[((month % 12) + 12) % 12]} ${year}`;
}

/** Date locale « AAAA-MM-JJ ». */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Jour local d'une date ISO ; null si invalide. */
export function sessionDateKey(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? localDateKey(new Date(t)) : null;
}

/** Mois décalé de `delta` (−1 : précédent, +1 : suivant). */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Type d'après le nom de la séance (« Push A », « Jambes », « Full body »…).
 * null si le nom ne dit rien.
 */
export function kindFromName(name: string): SessionKind | null {
  const n = fold(name ?? '');
  if (/\bfull\b|fullbody|corps entier|total body/.test(n)) return 'full';
  if (/\bupper\b|haut du corps/.test(n)) return 'upper';
  const push = /\bpush\b|\bpousser\b|\bpoussee\b/.test(n);
  const pull = /\bpull\b|\btirer\b|\btirage\b/.test(n);
  const legs = /\blegs?\b|\bjambes?\b|\blower\b|bas du corps|\bcuisses\b/.test(n);
  const count = Number(push) + Number(pull) + Number(legs);
  if (count === 0) return null;
  if (count === 1) return push ? 'push' : pull ? 'pull' : 'legs';
  return legs ? 'full' : 'upper';
}

/**
 * Type d'après les muscles des séries de travail : un pattern ≥ 70 % des
 * séries l'emporte ; sinon haut du corps si les jambes font < 20 %, full body
 * sinon. « other » sans muscle classable (gainage, cardio).
 */
export function kindFromMuscles(session: CalendarSession, musclesOf: MusclesOf): SessionKind {
  let push = 0;
  let pull = 0;
  let legs = 0;
  for (const e of session.entries) {
    const n = workSetsOf(e.sets).length;
    if (n === 0) continue;
    const p = classifyPattern(musclesOf(e.exerciseId));
    if (p === 'push') push += n;
    else if (p === 'pull') pull += n;
    else if (p === 'legs') legs += n;
  }
  const total = push + pull + legs;
  if (total === 0) return 'other';
  if (push / total >= 0.7) return 'push';
  if (pull / total >= 0.7) return 'pull';
  if (legs / total >= 0.7) return 'legs';
  if (legs / total < 0.2) return 'upper';
  return 'full';
}

/** Type d'une séance : son nom d'abord, ses muscles sinon. */
export function sessionKind(session: CalendarSession, musclesOf: MusclesOf): SessionKind {
  return kindFromName(session.name) ?? kindFromMuscles(session, musclesOf);
}

/** Tonnage (Σ charge × reps) des séries de travail. */
export function sessionTonnageKg(session: CalendarSession): number {
  let kg = 0;
  for (const e of session.entries) {
    for (const s of workSetsOf(e.sets)) kg += (Number(s.weightKg) || 0) * (Number(s.reps) || 0);
  }
  return kg;
}

/** Séances d'un jour local, dans l'ordre chronologique. */
export function sessionsOnDay<S extends CalendarSession>(
  sessions: readonly S[],
  date: string,
): S[] {
  return sessions
    .filter((s) => sessionDateKey(s.startedAt) === date)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function emptyByKind(): Record<SessionKind, number> {
  return { push: 0, pull: 0, legs: 0, upper: 0, full: 0, other: 0 };
}

/**
 * Grille du mois `month` (0-11) de `year` : semaines complètes du lundi au
 * dimanche, jours des mois voisins inclus (inMonth = false, sans séances pour
 * ne pas brouiller la lecture). Le résumé ne compte que le mois affiché.
 */
export function buildMonthCalendar(input: {
  sessions: readonly CalendarSession[];
  musclesOf: MusclesOf;
  year: number;
  month: number;
  now?: Date;
}): MonthCalendar {
  const { year, month, musclesOf } = input;
  const now = input.now ?? new Date();
  const todayKey = localDateKey(now);

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // lundi = 0
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));

  // Séances du mois, regroupées par jour (ordre chronologique).
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const byDay = new Map<string, Array<{ t: number; id: string; kind: SessionKind }>>();
  const summary: MonthSummary = { sessions: 0, tonnageKg: 0, activeDays: 0, byKind: emptyByKind() };
  for (const s of input.sessions) {
    const key = sessionDateKey(s.startedAt);
    if (!key || !key.startsWith(monthPrefix)) continue;
    const kind = sessionKind(s, musclesOf);
    const list = byDay.get(key) ?? [];
    list.push({ t: Date.parse(s.startedAt), id: s.id, kind });
    byDay.set(key, list);
    summary.sessions += 1;
    summary.tonnageKg += sessionTonnageKg(s);
    summary.byKind[kind] += 1;
  }
  summary.activeDays = byDay.size;
  summary.tonnageKg = Math.round(summary.tonnageKg);

  const weeks: CalendarDay[][] = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const key = localDateKey(cursor);
      const inMonth = cursor.getMonth() === month;
      const list = inMonth ? (byDay.get(key) ?? []).sort((a, b) => a.t - b.t) : [];
      week.push({
        date: key,
        day: cursor.getDate(),
        inMonth,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        sessionIds: list.map((x) => x.id),
        kinds: list.map((x) => x.kind),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return { year, month, label: monthLabel(year, month), weeks, summary };
}
