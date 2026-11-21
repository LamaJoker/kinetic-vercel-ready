/**
 * program-week.ts — relie la « semaine qui s'adapte » (@kinetic/core,
 * week-plan.domain) au stockage : programme suivi, séances faites cette
 * semaine, ajustements de l'utilisateur. Chargé à la demande (components/week-plan).
 *
 * Programme suivi : le découpage choisi dans /program (PROGRAM_ACTIVE) ou le
 * programme du catalogue /programs (ACTIVE_PROGRAM, semaine numérotée) ; si
 * les deux existent, le plus récemment choisi.
 */
import {
  STORAGE_KEYS,
  catalogPlanSessions,
  findProgram,
  mondayIndex,
  planWeek,
  sameSessionName,
  splitPlanSessions,
  type PlanDone,
  type PlanSession,
  type SplitDayLike,
  type StoragePort,
  type WeekAdjust,
  type WeekPlan,
} from '@kinetic/core';
import { loadSessions, loadTemplates } from './training/storage';
import { localIsoDate } from './training/next-session';
import type { WorkoutTemplate } from './training/types';

interface SplitProgram {
  id?: string;
  name?: string;
  createdAt?: string;
  schedule?: SplitDayLike[];
}
interface CatalogState {
  id?: string;
  weekIndex?: number;
  selectedAt?: string;
}
/** Ajustements enregistrés : valables pour une semaine et un programme. */
export interface StoredWeekAdjust extends WeekAdjust {
  week: string;
  programId: string;
}

export interface ProgramWeekView {
  programId: string;
  title: string;
  subtitle: string;
  /** Page où l'on gère le programme. */
  href: '/program' | '/programs';
  /** Lundi de la semaine (YYYY-MM-DD). */
  week: string;
  today: number;
  sessions: PlanSession[];
  done: PlanDone[];
  adjust: WeekAdjust;
  plan: WeekPlan;
}

/** Lundi (local) de la semaine de `now`. */
export function mondayOf(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - mondayIndex(d.getDay()));
  return d;
}

/** Même clé que program.page.ts (weekKey) pour les jours cochés dans /program. */
export function programWeekKey(monday: Date): string {
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const d = String(monday.getDate()).padStart(2, '0');
  return `${monday.getFullYear()}-W${m}-${d}`;
}

/** Programme suivi → séances de la semaine, ou null s'il n'y en a pas. */
export function resolveFollowedProgram(
  split: SplitProgram | null,
  catalog: CatalogState | null,
): Pick<ProgramWeekView, 'programId' | 'title' | 'subtitle' | 'href' | 'sessions'> | null {
  const entry = catalog?.id ? findProgram(catalog.id) : undefined;
  const splitOk = !!split?.schedule && split.schedule.some((d) => !d.restDay);
  const useCatalog =
    !!entry && (!splitOk || (catalog?.selectedAt ?? '') > (split?.createdAt ?? ''));
  if (useCatalog && entry) {
    const wi = Math.min(Math.max(0, Math.floor(catalog?.weekIndex ?? 0)), entry.weeks.length - 1);
    const week = entry.weeks[wi]!;
    return {
      programId: `${entry.id}#${wi}`,
      title: entry.name,
      subtitle: week.label,
      href: '/programs',
      sessions: catalogPlanSessions(week),
    };
  }
  if (!splitOk) return null;
  return {
    programId: split!.id ?? 'split',
    title: split!.name ?? 'Programme',
    subtitle: 'Cette semaine',
    href: '/program',
    sessions: splitPlanSessions(split!.schedule!),
  };
}

/** Lit tout ce qu'il faut et planifie la semaine. null : aucun programme suivi. */
export async function loadProgramWeek(
  storage: StoragePort,
  now: Date = new Date(),
): Promise<ProgramWeekView | null> {
  const monday = mondayOf(now);
  const week = localIsoDate(monday);
  const [split, catalog, stored, checked, sessions] = await Promise.all([
    storage.get<SplitProgram>(STORAGE_KEYS.PROGRAM_ACTIVE),
    storage.get<CatalogState>(STORAGE_KEYS.ACTIVE_PROGRAM),
    storage.get<StoredWeekAdjust>(STORAGE_KEYS.PROGRAM_WEEK_PLAN),
    storage.get<number[]>(STORAGE_KEYS.PROGRAM_COMPLETED_DAYS(programWeekKey(monday))),
    loadSessions(storage),
  ]);
  const program = resolveFollowedProgram(split, catalog);
  if (!program) return null;

  const today = mondayIndex(now.getDay());
  const start = monday.getTime();
  // Lundi suivant à minuit local (une semaine de changement d'heure fait 167 ou 169 h).
  const end = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7).getTime();
  const done: PlanDone[] = sessions
    .filter((s) => !!s.endedAt && s.entries.some((e) => e.sets.length > 0))
    .map((s) => ({ at: new Date(s.startedAt), name: s.name }))
    .filter(({ at }) => at.getTime() >= start && at.getTime() < end)
    .map(({ at, name }) => ({ day: mondayIndex(at.getDay()), name }))
    .filter((d) => d.day <= today);
  // Séance cochée exercice par exercice dans /program (sans séance enregistrée ce jour-là).
  if (program.href === '/program' && Array.isArray(checked)) {
    for (const dow of checked) {
      const day = mondayIndex(Number(dow));
      if (day <= today && !done.some((d) => d.day === day)) done.push({ day });
    }
  }
  const adjust: WeekAdjust =
    stored && stored.week === week && stored.programId === program.programId
      ? {
          moves: stored.moves ?? {},
          skipped: stored.skipped ?? [],
          unavailable: stored.unavailable ?? [],
        }
      : {};
  return {
    ...program,
    week,
    today,
    done,
    adjust,
    plan: planWeek(program.sessions, done, today, adjust),
  };
}

/** Applique de nouveaux ajustements : replanifie et enregistre. */
export async function saveProgramWeekAdjust(
  storage: StoragePort,
  view: ProgramWeekView,
  adjust: WeekAdjust,
): Promise<ProgramWeekView> {
  const value: StoredWeekAdjust = {
    week: view.week,
    programId: view.programId,
    moves: adjust.moves ?? {},
    skipped: adjust.skipped ?? [],
    unavailable: adjust.unavailable ?? [],
  };
  await storage.set(STORAGE_KEYS.PROGRAM_WEEK_PLAN, value);
  return { ...view, adjust, plan: planWeek(view.sessions, view.done, view.today, adjust) };
}

/** Modèle de séance correspondant à la séance prévue aujourd'hui (pour « Séance du jour »). */
export function templateForToday(
  view: ProgramWeekView,
  templates: readonly WorkoutTemplate[],
): WorkoutTemplate | null {
  const name = view.plan.today?.name;
  if (!name) return null;
  return (
    templates.find((t) => t.name.toLowerCase() === name.toLowerCase()) ??
    templates.find((t) => sameSessionName(t.name, name)) ??
    null
  );
}

export { loadTemplates };
