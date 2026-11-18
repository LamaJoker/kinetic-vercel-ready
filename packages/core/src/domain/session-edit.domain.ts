/**
 * Correction d'une séance : modifier, supprimer ou ajouter une série, renommer,
 * changer la date. Pur, zéro I/O : chaque fonction renvoie une NOUVELLE séance
 * (la page la remplace, ce qui l'enregistre).
 *
 * Records, e1RM, tonnage et succès sont recalculés à la volée depuis les séances :
 * corriger une série suffit à corriger tout ce qui en dérive.
 */
import { isTimedSet, warmupSetsOf, workSetsOf } from './workout-sets.domain.js';

export interface EditableSet {
  setIndex: number;
  reps: number;
  weightKg: number;
  rpe: number;
  performedAt: string;
  note?: string;
  kind?: 'work' | 'warmup';
  /** Série chronométrée (s) ; `reps` vaut alors 0. */
  durationSec?: number;
  /** Série de distance (m) ; `reps` vaut alors 0. */
  distanceM?: number;
}

interface EditableSession<S extends EditableSet> {
  name: string;
  startedAt: string;
  endedAt?: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly S[] }>;
}

export interface SetInput {
  weightKg: number;
  reps: number;
  rpe: number;
  note?: string;
  warmup?: boolean;
  /** Série chronométrée ou de distance : `reps` vaut 0 et l'un de ces champs est > 0. */
  durationSec?: number;
  distanceM?: number;
}

const NOTE_MAX = 200;

/** Message d'erreur en français, ou null si la saisie est valide. */
export function validateSetInput(input: SetInput): string | null {
  const { weightKg, reps, rpe } = input;
  if (!Number.isFinite(weightKg) || weightKg < 0 || weightKg > 1000)
    return 'Charge invalide (0 à 1000 kg).';
  if (input.durationSec !== undefined || input.distanceM !== undefined) {
    const d = Number(input.durationSec ?? 0);
    const m = Number(input.distanceM ?? 0);
    if (!Number.isFinite(d) || d < 0 || d > 86_400) return 'Durée invalide (m:ss, 24 h au plus).';
    if (!Number.isFinite(m) || m < 0 || m > 1_000_000) return 'Distance invalide.';
    if (d <= 0 && m <= 0) return 'Indique une durée ou une distance.';
  } else if (!Number.isInteger(reps) || reps < 1 || reps > 200) return 'Reps invalides (1 à 200).';
  if (!Number.isFinite(rpe) || rpe < 6 || rpe > 10) return 'RPE invalide (6–10).';
  return null;
}

/** Échauffements d'abord, puis travail ; setIndex renuméroté de façon contiguë. */
export function orderSetEntries<S extends EditableSet>(sets: readonly S[]): S[] {
  return [...warmupSetsOf(sets), ...workSetsOf(sets)].map((s, i) => ({ ...s, setIndex: i }));
}

function applyInput<S extends EditableSet>(set: S, input: SetInput): S {
  const rest: EditableSet = { ...set };
  delete rest.note;
  delete rest.kind;
  delete rest.durationSec;
  delete rest.distanceM;
  const note = (input.note ?? '').trim().slice(0, NOTE_MAX);
  const timed = input.durationSec !== undefined || input.distanceM !== undefined;
  const d = Math.round(Number(input.durationSec ?? 0));
  const m = Number(input.distanceM ?? 0);
  return {
    ...rest,
    weightKg: input.weightKg,
    reps: timed ? 0 : input.reps,
    rpe: input.rpe,
    ...(timed && d > 0 ? { durationSec: d } : {}),
    ...(timed && m > 0 ? { distanceM: m } : {}),
    ...(note ? { note } : {}),
    ...(input.warmup ? { kind: 'warmup' as const } : {}),
  } as S;
}

function mapEntry<S extends EditableSet, T extends EditableSession<S>>(
  session: T,
  exerciseId: string,
  fn: (sets: readonly S[]) => S[],
): T {
  return {
    ...session,
    entries: session.entries.map((e) =>
      e.exerciseId === exerciseId ? { ...e, sets: orderSetEntries(fn(e.sets)) } : e,
    ),
  };
}

/** Remplace la série `setIndex` de l'exercice (charge, reps, RPE, note, type). */
export function updateSessionSet<S extends EditableSet, T extends EditableSession<S>>(
  session: T,
  exerciseId: string,
  setIndex: number,
  input: SetInput,
): T {
  return mapEntry(session, exerciseId, (sets) =>
    sets.map((s) => (s.setIndex === setIndex ? applyInput(s, input) : s)),
  );
}

/** Retire la série `setIndex` de l'exercice. */
export function removeSessionSet<S extends EditableSet, T extends EditableSession<S>>(
  session: T,
  exerciseId: string,
  setIndex: number,
): T {
  return mapEntry(session, exerciseId, (sets) => sets.filter((s) => s.setIndex !== setIndex));
}

/**
 * Insère une série à la position de son setIndex (annulation d'une suppression),
 * ou à la fin de son groupe si l'index dépasse.
 */
export function insertSessionSet<S extends EditableSet, T extends EditableSession<S>>(
  session: T,
  exerciseId: string,
  set: S,
): T {
  return mapEntry(session, exerciseId, (sets) => {
    const next = [...sets];
    next.splice(Math.max(0, Math.min(set.setIndex, next.length)), 0, set);
    return next;
  });
}

/** Nouvelle série de travail (série oubliée) : reprend la dernière série de l'exercice. */
export function forgottenSet<S extends EditableSet>(
  sets: readonly S[],
  fallbackAt: string,
): EditableSet {
  const last = workSetsOf(sets).at(-1) ?? sets.at(-1);
  const at = Date.parse(last?.performedAt ?? fallbackAt);
  const timed = last && isTimedSet(last);
  return {
    setIndex: sets.length,
    weightKg: last?.weightKg ?? 20,
    reps: timed ? 0 : (last?.reps ?? 8),
    rpe: last?.rpe ?? 8,
    ...(timed && last.durationSec ? { durationSec: last.durationSec } : {}),
    ...(timed && last.distanceM ? { distanceM: last.distanceM } : {}),
    performedAt: new Date((Number.isFinite(at) ? at : Date.parse(fallbackAt)) + 1000).toISOString(),
  };
}

/**
 * Change la date/heure de début : la fin et l'heure de chaque série sont décalées
 * d'autant (durée et ordre conservés, records datés au bon jour).
 */
export function retimeSession<S extends EditableSet, T extends EditableSession<S>>(
  session: T,
  newStartIso: string,
): T {
  const from = Date.parse(session.startedAt);
  const to = Date.parse(newStartIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return session;
  const delta = to - from;
  const shift = (iso: string): string => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t + delta).toISOString() : iso;
  };
  return {
    ...session,
    startedAt: new Date(to).toISOString(),
    ...(session.endedAt ? { endedAt: shift(session.endedAt) } : {}),
    entries: session.entries.map((e) => ({
      ...e,
      sets: e.sets.map((s) => ({ ...s, performedAt: shift(s.performedAt) })),
    })),
  };
}

/** RPE moyen des séries de travail (arrondi à 0,1), null sans série. */
export function workAvgRpe(session: EditableSession<EditableSet>): number | null {
  const rpes = session.entries.flatMap((e) => workSetsOf(e.sets).map((s) => s.rpe));
  if (!rpes.length) return null;
  return Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10;
}

/** « 2026-11-18T07:30 » pour un champ datetime-local (heure locale). */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
