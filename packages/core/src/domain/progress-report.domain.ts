/**
 * Bilan de progression en PDF (Profil › Données, page Bilan) : données de la
 * période (séances, tonnage, régularité, records et e1RM des principaux
 * exercices, poids de corps, mensurations, groupes musculaires, objectifs de
 * force, notes) puis mise en page A4 sur plusieurs pages via pdf-writer.
 * Pur, zéro I/O : l'application lit le stockage et partage le fichier.
 */
import { e1rm } from './progression.domain.js';
import { isTimedSet, workSetsOf, type LoadedSet, type TimedFields } from './workout-sets.domain.js';
import { MUSCLE_REGIONS, regionWeights } from './muscle-map.domain.js';
import {
  evaluateGoal,
  goalEtaLabel,
  goalLabel,
  type GoalSession,
  type StrengthGoal,
} from './strength-goals.domain.js';
import {
  createPdf,
  textWidth,
  wrapText,
  type PdfColor,
  type PdfPage,
} from './pdf-writer.domain.js';

// ─── Période ──────────────────────────────────────────────────

export type ReportPeriodKey = '4w' | '3m' | '6m' | '1y' | 'all';

export const REPORT_PERIODS: ReadonlyArray<{ key: ReportPeriodKey; label: string }> = [
  { key: '4w', label: '4 semaines' },
  { key: '3m', label: '3 mois' },
  { key: '6m', label: '6 mois' },
  { key: '1y', label: '1 an' },
  { key: 'all', label: 'Tout' },
];

export function isReportPeriodKey(v: unknown): v is ReportPeriodKey {
  return REPORT_PERIODS.some((p) => p.key === v);
}

const DAY = 86_400_000;

/** Début de la période (ms). « Tout » : la plus ancienne donnée (`earliest`), sinon maintenant. */
export function reportPeriodStart(key: ReportPeriodKey, now: number, earliest?: number): number {
  if (key === 'all') return Math.min(now, earliest ?? now);
  if (key === '4w') return now - 28 * DAY;
  const d = new Date(now);
  d.setMonth(d.getMonth() - (key === '3m' ? 3 : key === '6m' ? 6 : 12));
  return d.getTime();
}

// ─── Entrées ──────────────────────────────────────────────────

export type ReportSet = LoadedSet &
  TimedFields & { note?: string | undefined; performedAt?: string };

export interface ReportSession {
  startedAt: string;
  endedAt?: string | undefined;
  durationMin?: number | undefined;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly ReportSet[] }>;
}

export interface ReportBodyweight {
  date: string;
  weight: number;
  note?: string | null;
}

export type ReportMeasurement = { date: string; note?: string | undefined } & Partial<
  Record<string, unknown>
>;

export interface ProgressReportInput {
  name?: string;
  period: ReportPeriodKey;
  sessions: readonly ReportSession[];
  exerciseName: (id: string) => string;
  musclesOf?: (id: string) => readonly string[];
  bodyweight?: readonly ReportBodyweight[];
  measurements?: readonly ReportMeasurement[];
  goals?: readonly StrengthGoal[];
}

// ─── Résultat ─────────────────────────────────────────────────

export interface ReportPoint {
  t: number;
  v: number;
}

export interface ReportExercise {
  id: string;
  name: string;
  sessions: number;
  bestE1rm: number;
  firstE1rm: number;
  lastE1rm: number;
  /** Variation de l'e1RM entre la première et la dernière séance (%), null si une seule. */
  deltaPct: number | null;
  bestSet: { weightKg: number; reps: number; t: number } | null;
  /** Records d'e1RM battus pendant la période (comparés à tout l'historique antérieur). */
  records: number;
  points: ReportPoint[];
}

export interface ReportMetric {
  key: string;
  label: string;
  points: ReportPoint[];
  first: number;
  last: number;
}

export interface ProgressReport {
  name: string;
  periodLabel: string;
  start: number;
  end: number;
  summary: {
    sessions: number;
    minutes: number;
    tonnageKg: number;
    workSets: number;
    activeWeeks: number;
    totalWeeks: number;
    /** Semaines actives / semaines de la période, 0–100. */
    regularityPct: number;
    perWeek: number;
    records: number;
    bodyweightStart: number | null;
    bodyweightEnd: number | null;
  };
  /** Séances par semaine (de la plus ancienne à la plus récente). */
  weekly: number[];
  exercises: ReportExercise[];
  bodyweight: ReportPoint[];
  measurements: ReportMetric[];
  muscles: Array<{ label: string; sets: number }>;
  goals: Array<{ label: string; pct: number; current: number; target: number; eta: string }>;
  notes: Array<{ t: number; source: string; text: string }>;
}

export const REPORT_METRICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'waist', label: 'Tour de taille' },
  { key: 'chest', label: 'Poitrine' },
  { key: 'hips', label: 'Hanches' },
  { key: 'shoulders', label: 'Épaules' },
  { key: 'leftBicep', label: 'Bras gauche' },
  { key: 'rightBicep', label: 'Bras droit' },
  { key: 'leftThigh', label: 'Cuisse gauche' },
  { key: 'rightThigh', label: 'Cuisse droite' },
  { key: 'leftCalf', label: 'Mollet gauche' },
  { key: 'rightCalf', label: 'Mollet droit' },
  { key: 'neck', label: 'Cou' },
];

const MAX_EXERCISES = 6;
const MAX_NOTES = 14;

const time = (iso: string | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : NaN;
};
/** Dates « AAAA-MM-JJ » : midi local, pour ne jamais glisser d'un jour. */
const dayTime = (day: string): number =>
  time(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00` : day);

const loadSets = (sets: readonly ReportSet[]): ReportSet[] =>
  workSetsOf(sets).filter((s) => !isTimedSet(s) && s.reps >= 1 && Number(s.weightKg) >= 0);
/** Séries chargées (charge > 0) : seules à donner une e1RM utile (pas les dips au poids du corps). */
const e1rmSets = (sets: readonly ReportSet[]): ReportSet[] =>
  loadSets(sets).filter((s) => Number(s.weightKg) > 0);

function sessionMinutes(s: ReportSession): number {
  if (Number(s.durationMin) > 0) return Math.min(300, Number(s.durationMin));
  const d = (time(s.endedAt) - time(s.startedAt)) / 60_000;
  return Number.isFinite(d) && d > 0 ? Math.min(300, d) : 0;
}

/** Plus ancienne date connue (séances, pesées, mensurations), pour la période « Tout ». */
export function earliestReportData(input: Omit<ProgressReportInput, 'period'>): number | undefined {
  const ts = [
    ...input.sessions.map((s) => time(s.startedAt)),
    ...(input.bodyweight ?? []).map((b) => dayTime(b.date)),
    ...(input.measurements ?? []).map((m) => dayTime(m.date)),
  ].filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : undefined;
}

const fullDate = (t: number): string =>
  new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** « 6 mois · du 22 mai 2026 au 22 novembre 2026 ». */
export function reportPeriodLabel(key: ReportPeriodKey, start: number, end: number): string {
  const label = REPORT_PERIODS.find((p) => p.key === key)?.label ?? '';
  const head = key === 'all' ? 'Tout l’historique' : label;
  return `${head} · du ${fullDate(start)} au ${fullDate(end)}`;
}

export function buildProgressReport(input: ProgressReportInput, now: number): ProgressReport {
  const start = reportPeriodStart(input.period, now, earliestReportData(input));
  const end = now;
  const inside = (t: number) => t >= start && t <= end;
  const all = [...input.sessions]
    .filter((s) => Number.isFinite(time(s.startedAt)))
    .sort((a, b) => time(a.startedAt) - time(b.startedAt));
  const sessions = all.filter((s) => inside(time(s.startedAt)));

  // Synthèse, semaines, groupes musculaires, notes de séries.
  const totalWeeks = Math.max(1, Math.ceil((end - start) / (7 * DAY)));
  const weekly = new Array<number>(totalWeeks).fill(0);
  let minutes = 0;
  let tonnageKg = 0;
  let workSets = 0;
  const regions = new Map<string, number>();
  const notes: ProgressReport['notes'] = [];
  const exStats = new Map<string, { sessions: number; sets: number }>();
  for (const s of sessions) {
    const t = time(s.startedAt);
    const w = Math.min(totalWeeks - 1, Math.max(0, Math.floor((t - start) / (7 * DAY))));
    weekly[w] = (weekly[w] ?? 0) + 1;
    minutes += sessionMinutes(s);
    for (const e of s.entries) {
      const work = workSetsOf(e.sets);
      const loaded = loadSets(e.sets);
      workSets += work.length;
      for (const set of loaded) tonnageKg += Number(set.weightKg) * set.reps;
      const weighted = e1rmSets(e.sets);
      if (weighted.length) {
        const st = exStats.get(e.exerciseId) ?? { sessions: 0, sets: 0 };
        st.sessions += 1;
        st.sets += weighted.length;
        exStats.set(e.exerciseId, st);
      }
      if (input.musclesOf && work.length) {
        for (const [r, wgt] of regionWeights(input.musclesOf(e.exerciseId)))
          regions.set(r, (regions.get(r) ?? 0) + wgt * work.length);
      }
      for (const set of e.sets) {
        const text = typeof set.note === 'string' ? set.note.trim() : '';
        if (text) {
          const nt = time(set.performedAt);
          notes.push({
            t: Number.isFinite(nt) ? nt : t,
            source: input.exerciseName(e.exerciseId),
            text,
          });
        }
      }
    }
  }
  const activeWeeks = weekly.filter((n) => n > 0).length;

  // Exercices principaux : le plus de séances, puis le plus de séries.
  const top = [...exStats.entries()]
    .sort(
      (a, b) => b[1].sessions - a[1].sessions || b[1].sets - a[1].sets || a[0].localeCompare(b[0]),
    )
    .slice(0, MAX_EXERCISES);
  let totalRecords = 0;
  const exercises: ReportExercise[] = top.map(([id, st]) => {
    let before = 0;
    let records = 0;
    let bestSet: ReportExercise['bestSet'] = null;
    const points: ReportPoint[] = [];
    for (const s of all) {
      const t = time(s.startedAt);
      if (t > end) break;
      let best = 0;
      for (const e of s.entries) {
        if (e.exerciseId !== id) continue;
        for (const set of e1rmSets(e.sets)) {
          best = Math.max(best, e1rm(Number(set.weightKg), set.reps));
          const kg = Number(set.weightKg);
          if (
            inside(t) &&
            (!bestSet ||
              kg > bestSet.weightKg ||
              (kg === bestSet.weightKg && set.reps > bestSet.reps))
          )
            bestSet = { weightKg: kg, reps: set.reps, t };
        }
      }
      if (best <= 0) continue;
      if (inside(t)) {
        points.push({ t, v: round1(best) });
        if (before > 0 && best > before + 1e-9) records += 1;
      }
      before = Math.max(before, best);
    }
    totalRecords += records;
    const first = points[0]?.v ?? 0;
    const last = points[points.length - 1]?.v ?? 0;
    return {
      id,
      name: input.exerciseName(id),
      sessions: st.sessions,
      bestE1rm: Math.max(0, ...points.map((p) => p.v)),
      firstE1rm: first,
      lastE1rm: last,
      deltaPct:
        points.length > 1 && first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : null,
      bestSet,
      records,
      points,
    };
  });

  // Poids de corps.
  const bodyweight = (input.bodyweight ?? [])
    .map((b) => ({ t: dayTime(b.date), v: Number(b.weight), note: b.note }))
    .filter((p) => Number.isFinite(p.t) && p.v > 0 && inside(p.t))
    .sort((a, b) => a.t - b.t);
  for (const b of bodyweight)
    if (typeof b.note === 'string' && b.note.trim())
      notes.push({ t: b.t, source: 'Pesée', text: b.note.trim() });

  // Mensurations.
  const meas = (input.measurements ?? [])
    .map((m) => ({ m, t: dayTime(m.date) }))
    .filter((x) => Number.isFinite(x.t) && inside(x.t))
    .sort((a, b) => a.t - b.t);
  const measurements: ReportMetric[] = [];
  for (const def of REPORT_METRICS) {
    const points = meas
      .map(({ m, t }) => ({ t, v: Number(m[def.key]) }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0);
    if (points.length)
      measurements.push({
        ...def,
        points,
        first: points[0]!.v,
        last: points[points.length - 1]!.v,
      });
  }
  for (const { m, t } of meas)
    if (typeof m.note === 'string' && m.note.trim())
      notes.push({ t, source: 'Mensurations', text: m.note.trim() });

  // Groupes musculaires (séries de travail, muscle principal 1, secondaire 0,5).
  const muscles = MUSCLE_REGIONS.map((r) => ({
    label: r.label,
    sets: round1(regions.get(r.key) ?? 0),
  }))
    .filter((m) => m.sets > 0)
    .sort((a, b) => b.sets - a.sets);

  // Objectifs de force (état actuel, toutes séances confondues).
  const goalSessions = all as unknown as readonly GoalSession[];
  const goals = (input.goals ?? []).map((g) => {
    const st = evaluateGoal(g, goalSessions, now);
    return {
      label: goalLabel(g, input.exerciseName(g.exerciseId)),
      pct: st.pct,
      current: round1(st.current),
      target: round1(st.target),
      eta: goalEtaLabel(st, now),
    };
  });

  return {
    name: (input.name ?? '').trim() || 'Athlète Kinetic',
    periodLabel: reportPeriodLabel(input.period, start, end),
    start,
    end,
    summary: {
      sessions: sessions.length,
      minutes: Math.round(minutes),
      tonnageKg: Math.round(tonnageKg),
      workSets,
      activeWeeks,
      totalWeeks,
      regularityPct: Math.round((activeWeeks / totalWeeks) * 100),
      perWeek: round1(sessions.length / totalWeeks),
      records: totalRecords,
      bodyweightStart: bodyweight[0]?.v ?? null,
      bodyweightEnd: bodyweight[bodyweight.length - 1]?.v ?? null,
    },
    weekly,
    exercises,
    bodyweight: bodyweight.map(({ t, v }) => ({ t, v })),
    measurements,
    muscles,
    goals,
    notes: notes.sort((a, b) => b.t - a.t).slice(0, MAX_NOTES),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Mise en forme ────────────────────────────────────────────

/** Nombre à la française : « 12 450 », « 82,5 ». */
export function fmtFr(n: number, digits = 1): string {
  return n
    .toLocaleString('fr-FR', { maximumFractionDigits: digits })
    .replace(/[\u202f\u00a0]/g, ' ');
}

/** « +2,5 », « –1,2 » (tiret demi-cadratin : le signe moins n'existe pas en WinAnsi). */
const signed = (n: number, digits = 1): string =>
  `${n > 0 ? '+' : n < 0 ? '–' : ''}${fmtFr(Math.abs(n), digits)}`;
const shortDate = (t: number): string =>
  new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const hours = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};
const tonnage = (kg: number): { value: string; unit: string } =>
  kg >= 10_000 ? { value: fmtFr(kg / 1000, 1), unit: 't' } : { value: fmtFr(kg, 0), unit: 'kg' };

/** Nom du fichier : « kinetic-bilan-2026-11-22.pdf ». */
export function progressReportFileName(now: number): string {
  const d = new Date(now);
  const p = (v: number) => String(v).padStart(2, '0');
  return `kinetic-bilan-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.pdf`;
}

// ─── Rendu PDF ────────────────────────────────────────────────

const INK: PdfColor = [22, 24, 38];
const MUTED: PdfColor = [108, 112, 128];
const RULE: PdfColor = [228, 229, 236];
const SOFT: PdfColor = [246, 246, 249];
const NIGHT: PdfColor = [17, 19, 33];
const CORAL: PdfColor = [255, 122, 102];
const CORAL_INK: PdfColor = [208, 80, 60];
const TEAL: PdfColor = [28, 160, 137];
const VIOLET: PdfColor = [118, 96, 222];
const AMBER: PdfColor = [222, 150, 40];
const WHITE: PdfColor = [255, 255, 255];

const M = 48; // marge
const FOOT = 790; // limite basse du contenu

interface Cursor {
  page: PdfPage;
  y: number;
}

/** Courbe : cadre léger, min / max à gauche, dates aux extrémités si `axis`. */
function chart(
  p: PdfPage,
  box: { x: number; y: number; w: number; h: number },
  points: readonly ReportPoint[],
  color: PdfColor,
  axis?: { unit: string },
): void {
  const { x, y, w, h } = box;
  const left = axis ? x + 34 : x;
  const bottom = axis ? y + h - 14 : y + h;
  const cw = x + w - left;
  const ch = bottom - y;
  p.rect(left, y, cw, ch, SOFT);
  if (points.length === 0) return;
  const vs = points.map((q) => q.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  const pad = (hi - lo) * 0.15 || Math.max(1, hi * 0.03);
  lo -= pad;
  hi += pad;
  const t0 = points[0]!.t;
  const span = points[points.length - 1]!.t - t0 || 1;
  const px = (t: number) =>
    points.length === 1 ? left + cw / 2 : left + 6 + ((t - t0) / span) * (cw - 12);
  const py = (v: number) => y + 6 + (1 - (v - lo) / (hi - lo)) * (ch - 12);
  if (axis) {
    for (const v of [hi - pad, lo + pad]) {
      p.line(left, py(v), left + cw, py(v), { width: 0.5, color: RULE, dash: [2, 2] });
      p.text(left - 4, py(v) + 3, `${fmtFr(v)}${axis.unit}`, {
        size: 7,
        color: MUTED,
        align: 'right',
      });
    }
    p.text(left, y + h - 2, shortDate(t0), { size: 7, color: MUTED });
    p.text(left + cw, y + h - 2, shortDate(points[points.length - 1]!.t), {
      size: 7,
      color: MUTED,
      align: 'right',
    });
  }
  p.polyline(
    points.map((q) => [px(q.t), py(q.v)] as const),
    { width: axis ? 1.8 : 1.4, color },
  );
  const lastP = points[points.length - 1]!;
  p.dot(px(lastP.t), py(lastP.v), axis ? 4.5 : 3.5, color);
}

/** Rendu du bilan en PDF (chaîne ASCII, prête à écrire en latin1 / ASCII). */
export function renderProgressReportPdf(r: ProgressReport, now: number): string {
  const doc = createPdf({
    title: `Bilan de progression — ${r.name}`,
    author: r.name,
    createdAt: new Date(now),
  });
  const pages: PdfPage[] = [];
  const S = r.summary;

  // ── Page de garde ──
  const cover = doc.addPage();
  pages.push(cover);
  cover.rect(0, 0, cover.width, 360, NIGHT);
  cover.rect(M, 92, 36, 4, CORAL);
  cover.text(M, 80, 'KINETIC', { size: 11, bold: true, color: CORAL });
  cover.text(M, 150, 'Bilan de progression', { size: 32, bold: true, color: WHITE });
  cover.text(M, 190, r.name, { size: 17, color: [220, 222, 235] });
  let cy = 228;
  for (const line of wrapText(r.periodLabel, cover.width - 2 * M, 11)) {
    cover.text(M, cy, line, { size: 11, color: [170, 174, 196] });
    cy += 15;
  }
  cover.text(M, 330, `Généré le ${fullDate(now)}`, { size: 9, color: [130, 134, 158] });

  const ton = tonnage(S.tonnageKg);
  const tiles: Array<[string, string, string, PdfColor]> = [
    ['Séances', fmtFr(S.sessions, 0), `${fmtFr(S.perWeek)} par semaine`, CORAL_INK],
    ['Tonnage', `${ton.value} ${ton.unit}`, `${fmtFr(S.workSets, 0)} séries de travail`, VIOLET],
    [
      'Régularité',
      `${S.regularityPct} %`,
      `${S.activeWeeks} sem. actives sur ${S.totalWeeks}`,
      TEAL,
    ],
    ['Records', fmtFr(S.records, 0), 'e1RM battues', AMBER],
  ];
  const tw = (cover.width - 2 * M - 3 * 12) / 4;
  tiles.forEach(([label, value, sub, color], i) => {
    const x = M + i * (tw + 12);
    cover.rect(x, 400, tw, 92, SOFT);
    cover.rect(x, 400, tw, 3, color);
    cover.text(x + 12, 424, label, { size: 9, color: MUTED });
    cover.text(x + 12, 456, value, { size: 20, bold: true, color: INK });
    cover.text(x + 12, 478, sub, { size: 7.5, color: MUTED });
  });
  cover.text(M, 540, 'Au sommaire', { size: 13, bold: true, color: INK });
  [
    'Synthèse de la période et régularité',
    'Records et e1RM des principaux exercices',
    'Poids de corps et mensurations',
    'Répartition par groupe musculaire',
    'Objectifs de force et notes',
  ].forEach((t, i) => {
    cover.dot(M + 3, 563 + i * 20, 4, CORAL);
    cover.text(M + 14, 566 + i * 20, t, { size: 11, color: INK });
  });
  cover.text(M, 780, 'e1RM : charge maximale estimée sur une répétition (formule d’Epley).', {
    size: 8,
    color: MUTED,
  });

  // ── Pages de contenu (flux) ──
  const c: Cursor = { page: cover, y: FOOT };
  const newPage = () => {
    c.page = doc.addPage();
    pages.push(c.page);
    c.y = 70;
  };
  const ensure = (h: number) => {
    if (c.y + h > FOOT) newPage();
  };
  const section = (title: string, sub?: string) => {
    ensure(sub ? 90 : 76);
    c.y += 10;
    c.page.rect(M, c.y - 13, 4, 16, CORAL);
    c.page.text(M + 12, c.y, title, { size: 16, bold: true, color: INK });
    c.y += 8;
    if (sub) {
      c.y += 10;
      c.page.text(M + 12, c.y, sub, { size: 9, color: MUTED });
    }
    c.y += 18;
  };
  const empty = (text: string) => {
    ensure(24);
    c.page.text(M, c.y + 6, text, { size: 10, color: MUTED });
    c.y += 26;
  };
  const W = cover.width - 2 * M;

  // Synthèse.
  newPage();
  section('Synthèse', r.periodLabel);
  const bwStart = S.bodyweightStart;
  const bwEnd = S.bodyweightEnd;
  const stats: Array<[string, string, string]> = [
    ['Séances', fmtFr(S.sessions, 0), `${fmtFr(S.perWeek)} par semaine en moyenne`],
    [
      'Temps d’entraînement',
      hours(S.minutes),
      S.sessions ? `${Math.round(S.minutes / S.sessions)} min par séance` : '—',
    ],
    ['Tonnage', `${ton.value} ${ton.unit}`, `${fmtFr(S.workSets, 0)} séries de travail`],
    ['Régularité', `${S.regularityPct} %`, `${S.activeWeeks} semaines actives sur ${S.totalWeeks}`],
    [
      'Poids de corps',
      bwEnd !== null ? `${fmtFr(bwEnd)} kg` : '—',
      bwStart !== null && bwEnd !== null
        ? `début ${fmtFr(bwStart)} kg · ${signed(bwEnd - bwStart)} kg`
        : 'Aucune pesée sur la période',
    ],
    ['Records battus', fmtFr(S.records, 0), 'e1RM des principaux exercices'],
  ];
  const sw = (W - 12) / 2;
  stats.forEach(([label, value, sub], i) => {
    const x = M + (i % 2) * (sw + 12);
    const y = c.y + Math.floor(i / 2) * 70;
    c.page.rect(x, y, sw, 60, SOFT);
    c.page.text(x + 14, y + 18, label, { size: 9, color: MUTED });
    c.page.text(x + 14, y + 40, value, { size: 17, bold: true, color: INK });
    c.page.text(x + sw - 14, y + 40, sub, { size: 8, color: MUTED, align: 'right' });
  });
  c.y += 3 * 70 + 10;

  // Séances par semaine (barres).
  ensure(150);
  c.page.text(M, c.y + 6, 'Séances par semaine', { size: 11, bold: true, color: INK });
  c.y += 18;
  const maxW = Math.max(1, ...r.weekly);
  const n = r.weekly.length;
  const gap = n > 30 ? 1 : 3;
  const bw = (W - gap * (n - 1)) / n;
  const bh = 90;
  c.page.line(M, c.y + bh, M + W, c.y + bh, { width: 0.6, color: RULE });
  r.weekly.forEach((v, i) => {
    const h = (v / maxW) * (bh - 6);
    if (v > 0) c.page.rect(M + i * (bw + gap), c.y + bh - h, bw, h, CORAL);
  });
  c.page.text(M, c.y + bh + 12, shortDate(r.start), { size: 7, color: MUTED });
  c.page.text(M + W, c.y + bh + 12, shortDate(r.end), { size: 7, color: MUTED, align: 'right' });
  c.page.text(M + W, c.y - 6, `max ${maxW} / sem.`, { size: 7, color: MUTED, align: 'right' });
  c.y += bh + 30;

  // Records et e1RM.
  section('Records et e1RM', 'Meilleure e1RM par séance, exercices les plus pratiqués');
  if (!r.exercises.length) empty('Aucune série chargée sur la période.');
  for (const ex of r.exercises) {
    ensure(84);
    const y = c.y;
    c.page.rect(M, y, W, 74, SOFT);
    c.page.text(M + 14, y + 20, ex.name, { size: 12, bold: true, color: INK });
    const head = `e1RM max ${fmtFr(ex.bestE1rm)} kg`;
    c.page.text(M + 14, y + 38, head, { size: 10, color: INK });
    if (ex.deltaPct !== null)
      c.page.text(
        M + 14 + textWidth(head, 10) + 8,
        y + 38,
        `${signed(ex.deltaPct)} % sur la période`,
        {
          size: 10,
          bold: true,
          color: ex.deltaPct > 0 ? TEAL : ex.deltaPct < 0 ? CORAL_INK : MUTED,
        },
      );
    const best = ex.bestSet
      ? `Meilleure série ${fmtFr(ex.bestSet.weightKg)} kg × ${ex.bestSet.reps} (${shortDate(ex.bestSet.t)})`
      : '';
    c.page.text(M + 14, y + 54, best, { size: 8.5, color: MUTED });
    c.page.text(
      M + 14,
      y + 66,
      `${ex.sessions} séance${ex.sessions > 1 ? 's' : ''}${ex.records ? ` · ${ex.records} record${ex.records > 1 ? 's' : ''} battu${ex.records > 1 ? 's' : ''}` : ''}`,
      { size: 8.5, color: MUTED },
    );
    chart(c.page, { x: M + W - 200, y: y + 10, w: 186, h: 54 }, ex.points, CORAL);
    c.y += 84;
  }

  // Poids de corps et mensurations.
  section(
    'Poids de corps',
    S.bodyweightStart !== null && S.bodyweightEnd !== null
      ? `De ${fmtFr(S.bodyweightStart)} à ${fmtFr(S.bodyweightEnd)} kg (${signed(S.bodyweightEnd - S.bodyweightStart)} kg)`
      : undefined,
  );
  if (r.bodyweight.length) {
    ensure(170);
    chart(c.page, { x: M, y: c.y, w: W, h: 160 }, r.bodyweight, TEAL, { unit: ' kg' });
    c.y += 176;
  } else empty('Aucune pesée sur la période.');

  section('Mensurations', 'Première et dernière mesure de la période, en cm');
  if (!r.measurements.length) empty('Aucune mensuration sur la période.');
  const mw = (W - 12) / 2;
  for (let i = 0; i < r.measurements.length; i += 2) {
    ensure(96);
    for (let j = 0; j < 2; j++) {
      const m = r.measurements[i + j];
      if (!m) continue;
      const x = M + j * (mw + 12);
      c.page.rect(x, c.y, mw, 86, SOFT);
      c.page.text(x + 12, c.y + 18, m.label, { size: 10, bold: true, color: INK });
      c.page.text(
        x + mw - 12,
        c.y + 18,
        m.points.length > 1
          ? `de ${fmtFr(m.first)} à ${fmtFr(m.last)} cm (${signed(m.last - m.first)})`
          : `${fmtFr(m.last)} cm`,
        { size: 8.5, color: MUTED, align: 'right' },
      );
      chart(c.page, { x: x + 12, y: c.y + 28, w: mw - 24, h: 48 }, m.points, VIOLET);
    }
    c.y += 96;
  }

  // Groupes musculaires.
  section(
    'Répartition par groupe musculaire',
    'Séries de travail (muscle principal 1, secondaire 0,5)',
  );
  if (!r.muscles.length) empty('Aucune série de travail sur la période.');
  const maxM = Math.max(1, ...r.muscles.map((m) => m.sets));
  const totalM = r.muscles.reduce((a, m) => a + m.sets, 0) || 1;
  for (const m of r.muscles) {
    ensure(20);
    c.page.text(M, c.y + 9, m.label, { size: 9.5, color: INK });
    const bx = M + 120;
    const bwid = W - 120 - 80;
    c.page.rect(bx, c.y + 1, bwid, 10, SOFT);
    c.page.rect(bx, c.y + 1, Math.max(2, (m.sets / maxM) * bwid), 10, VIOLET);
    c.page.text(M + W, c.y + 9, `${fmtFr(m.sets)} · ${Math.round((m.sets / totalM) * 100)} %`, {
      size: 8.5,
      color: MUTED,
      align: 'right',
    });
    c.y += 18;
  }
  c.y += 10;

  // Objectifs de force.
  section('Objectifs de force');
  if (!r.goals.length) empty('Aucun objectif de force défini.');
  for (const g of r.goals) {
    ensure(54);
    c.page.text(M, c.y + 10, g.label, { size: 10.5, bold: true, color: INK });
    c.page.text(M + W, c.y + 10, `${g.pct} %`, {
      size: 10.5,
      bold: true,
      color: g.pct >= 100 ? TEAL : CORAL_INK,
      align: 'right',
    });
    c.page.rect(M, c.y + 17, W, 6, SOFT);
    c.page.rect(
      M,
      c.y + 17,
      Math.max(2, (Math.min(100, g.pct) / 100) * W),
      6,
      g.pct >= 100 ? TEAL : CORAL,
    );
    c.page.text(
      M,
      c.y + 35,
      `e1RM actuelle ${fmtFr(g.current)} kg, cible ${fmtFr(g.target)} kg · ${g.eta}`,
      {
        size: 8.5,
        color: MUTED,
      },
    );
    c.y += 54;
  }

  // Notes.
  section('Notes', r.notes.length ? 'Les plus récentes de la période' : undefined);
  if (!r.notes.length) empty('Aucune note sur la période.');
  for (const note of r.notes) {
    const lines = wrapText(note.text, W - 110, 9.5);
    ensure(lines.length * 13 + 10);
    c.page.text(M, c.y + 9, shortDate(note.t), { size: 8.5, bold: true, color: MUTED });
    c.page.text(M, c.y + 21, note.source, { size: 7.5, color: MUTED });
    lines.forEach((l, i) => c.page.text(M + 110, c.y + 9 + i * 13, l, { size: 9.5, color: INK }));
    c.y += Math.max(28, lines.length * 13 + 10);
    c.page.line(M, c.y - 5, M + W, c.y - 5, { width: 0.5, color: RULE });
  }

  // En-têtes et pieds de page (le total est connu maintenant).
  pages.forEach((p, i) => {
    if (i > 0) {
      p.text(M, 40, `Kinetic · Bilan de progression · ${r.name}`, { size: 8, color: MUTED });
      p.line(M, 48, p.width - M, 48, { width: 0.5, color: RULE });
    }
    p.text(p.width - M, 815, `Page ${i + 1} / ${pages.length}`, {
      size: 8,
      color: MUTED,
      align: 'right',
    });
  });

  return doc.build();
}

/** Raccourci : données + rendu. */
export function progressReportPdf(input: ProgressReportInput, now: number): string {
  return renderProgressReportPdf(buildProgressReport(input, now), now);
}
