/**
 * next-session.ts — « Quelle séance aujourd'hui ? »
 *
 * Fonctions pures (aucun accès stockage) utilisées par le dashboard pour :
 * - proposer la prochaine séance (rotation Push/Pull/Legs A→B, ou modèle suivant) ;
 * - résumer la dernière séance terminée (volume, séries, durée) ;
 * - afficher la semaine en cours (lundi → dimanche) jour par jour.
 */
import type { WorkoutSession, WorkoutTemplate } from './types';

export const PPL_ROTATION = [
  'tpl-push-a',
  'tpl-pull-a',
  'tpl-legs-a',
  'tpl-push-b',
  'tpl-pull-b',
  'tpl-legs-b',
] as const;

export interface SessionSummary {
  id: string;
  name: string;
  startedAt: string;
  exerciseCount: number;
  setCount: number;
  volumeKg: number;
  durationMin: number | null;
}

export interface NextSession {
  templateId: string;
  name: string;
  exerciseCount: number;
  setCount: number;
  reason: 'first' | 'rotation' | 'next-template';
}

export interface WeekDay {
  label: string;
  iso: string;
  trained: boolean;
  isToday: boolean;
  isFuture: boolean;
}

export interface TrainingSnapshot {
  next: NextSession | null;
  last: SessionSummary | null;
  daysSinceLast: number | null;
  week: { days: WeekDay[]; count: number };
  totalSessions: number;
}

const DAY_LABELS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

/** Date locale YYYY-MM-DD (pas UTC : une séance à 23h reste le bon jour). */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function summarizeSession(s: WorkoutSession): SessionSummary {
  let setCount = 0;
  let volumeKg = 0;
  for (const entry of s.entries) {
    for (const set of entry.sets) {
      setCount++;
      volumeKg += Math.max(0, set.reps) * Math.max(0, set.weightKg);
    }
  }
  let durationMin: number | null = s.durationMin ?? null;
  if (durationMin === null && s.endedAt) {
    const ms = Date.parse(s.endedAt) - Date.parse(s.startedAt);
    if (Number.isFinite(ms) && ms > 0) durationMin = Math.round(ms / 60_000);
  }
  return {
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    exerciseCount: s.entries.length,
    setCount,
    volumeKg: Math.round(volumeKg),
    durationMin,
  };
}

function toNext(t: WorkoutTemplate, reason: NextSession['reason']): NextSession {
  return {
    templateId: t.id,
    name: t.name,
    exerciseCount: t.exercises.length,
    setCount: t.exercises.reduce((n, e) => n + e.sets, 0),
    reason,
  };
}

export function pickNextTemplate(
  lastTemplateId: string | undefined,
  templates: readonly WorkoutTemplate[],
): NextSession | null {
  if (templates.length === 0) return null;
  const byId = new Map(templates.map((t) => [t.id, t]));
  const rotation = PPL_ROTATION.filter((id) => byId.has(id));

  if (lastTemplateId) {
    const r = rotation.indexOf(lastTemplateId as (typeof PPL_ROTATION)[number]);
    if (r >= 0) return toNext(byId.get(rotation[(r + 1) % rotation.length]!)!, 'rotation');
    const i = templates.findIndex((t) => t.id === lastTemplateId);
    if (i >= 0) return toNext(templates[(i + 1) % templates.length]!, 'next-template');
  }
  const first = rotation[0] ? byId.get(rotation[0]) : templates[0];
  return first ? toNext(first, 'first') : null;
}

export function buildTrainingSnapshot(
  sessions: readonly WorkoutSession[],
  templates: readonly WorkoutTemplate[],
  now: Date = new Date(),
): TrainingSnapshot {
  const done = sessions
    .filter((s) => Boolean(s.endedAt) && s.entries.some((e) => e.sets.length > 0))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const lastSession = done[done.length - 1] ?? null;

  const todayIso = localIsoDate(now);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

  const trainedDays = new Set(done.map((s) => localIsoDate(new Date(s.startedAt))));
  const days: WeekDay[] = DAY_LABELS.map((label, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const iso = localIsoDate(d);
    return {
      label,
      iso,
      trained: trainedDays.has(iso),
      isToday: iso === todayIso,
      isFuture: iso > todayIso,
    };
  });

  let daysSinceLast: number | null = null;
  if (lastSession) {
    const last = new Date(lastSession.startedAt);
    const a = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
    const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    daysSinceLast = Math.max(0, Math.round((b - a) / 86_400_000));
  }

  return {
    next: pickNextTemplate(lastSession?.templateId, templates),
    last: lastSession ? summarizeSession(lastSession) : null,
    daysSinceLast,
    week: { days, count: days.filter((d) => d.trained).length },
    totalSessions: done.length,
  };
}

/** « aujourd'hui », « hier », « il y a 3 jours » */
export function relativeDayLabel(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  return `il y a ${days} jours`;
}

/** 12 480 kg → « 12,5 t » ; 840 → « 840 kg » */
export function formatVolume(kg: number): string {
  if (kg >= 1000) {
    return `${(kg / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} t`;
  }
  return `${Math.round(kg).toLocaleString('fr-FR')} kg`;
}
