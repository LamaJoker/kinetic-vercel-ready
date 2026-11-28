/**
 * Séance passée : saisir après coup une séance faite un jour précédent (date,
 * heure de début, durée), ou déplacer une séance de l'historique.
 *
 * Pur, zéro I/O. Les dates saisies sont en heure LOCALE (champs date/heure du
 * téléphone) ; les séances gardent des instants ISO (UTC), comme les autres.
 *
 * Règles : jamais dans le futur, jamais avant le 1er janvier 2000. Une séance
 * ajoutée a un identifiant neuf et s'insère à sa date : aucune autre séance
 * n'est remplacée, l'historique reste trié par date de séance.
 */
import { isTimedSet, workSetsOf } from './workout-sets.domain.js';
import { localDay } from './wellness.domain.js';
import type { EditableSet } from './session-edit.domain.js';

/** Date la plus ancienne acceptée (« AAAA-MM-JJ »). */
export const PAST_SESSION_MIN_DATE = '2000-01-01';
/** Durée maximale d'une séance saisie (min). */
export const PAST_SESSION_MAX_MIN = 600;

interface DatedSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  entries: ReadonlyArray<{ exerciseId: string; sets: readonly EditableSet[] }>;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Instant local « date + heure » (null si la date ou l'heure n'existe pas). */
export function localDateTime(date: string, time: string): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [y, m, day, h, min] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (h > 23 || min > 59) return null;
  const at = new Date(y, m - 1, day, h, min);
  // 31 février, 2026-13-01… : la date normalisée ne correspond plus à la saisie.
  if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== day) return null;
  return at;
}

/** « 2026-11-18T07:30 » (champ datetime-local) → instant local, ou null. */
export function parseLocalDateTime(value: string): Date | null {
  const [date = '', time = ''] = String(value ?? '').split('T');
  return localDateTime(date, time.slice(0, 5));
}

/** Début d'une séance (déplacée ou ajoutée) : ni futur, ni avant 2000. Message, ou null. */
export function validatePastStart(start: Date | null, now: Date): string | null {
  if (!start || !Number.isFinite(start.getTime())) return 'Date ou heure invalide.';
  if (localDay(start) < PAST_SESSION_MIN_DATE) return 'Date trop ancienne (2000 au plus tôt).';
  if (localDay(start) > localDay(now)) return 'La date ne peut pas être dans le futur.';
  if (start.getTime() > now.getTime()) return 'L’heure de début est dans le futur.';
  return null;
}

/**
 * Séance de l'historique déplacée : début valide ET fin (début + durée réelle `spanMs`,
 * fin − début de la séance) pas dans le futur. Message, ou null.
 */
export function validatePastMove(start: Date | null, spanMs: number, now: Date): string | null {
  const error = validatePastStart(start, now);
  if (error || !start) return error ?? 'Date ou heure invalide.';
  if (start.getTime() + (Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0) > now.getTime())
    return 'La séance finirait dans le futur : avance l’heure de début.';
  return null;
}

/**
 * Début et fin d'une séance passée : message d'erreur en français, ou null.
 * La fin ne peut pas dépasser maintenant (une séance passée est terminée).
 */
export function validatePastTiming(
  start: Date | null,
  durationMin: number,
  now: Date,
): string | null {
  const error = validatePastStart(start, now);
  if (error || !start) return error ?? 'Date ou heure invalide.';
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > PAST_SESSION_MAX_MIN)
    return `Durée invalide (1 à ${PAST_SESSION_MAX_MIN} min).`;
  if (start.getTime() + durationMin * 60_000 > now.getTime())
    return 'La séance finirait dans le futur : avance l’heure ou réduis la durée.';
  return null;
}

/** Valeurs par défaut de la feuille : fin de séance il y a une minute, aujourd'hui. */
export function defaultPastTiming(
  now: Date,
  durationMin = 60,
): { date: string; time: string; durationMin: number } {
  const start = new Date(now.getTime() - (durationMin + 1) * 60_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return {
    date: localDay(start),
    time: `${p(start.getHours())}:${p(start.getMinutes())}`,
    durationMin,
  };
}

/** Dernières séries de travail d'un exercice dans une séance commencée avant `beforeMs`. */
function lastWorkSets(
  history: readonly DatedSession[],
  exerciseId: string,
  beforeMs: number,
): readonly EditableSet[] {
  let best: { at: number; sets: readonly EditableSet[] } | null = null;
  for (const s of history) {
    const at = Date.parse(s.startedAt);
    if (!Number.isFinite(at) || at >= beforeMs || (best && at <= best.at)) continue;
    const sets = workSetsOf(s.entries.find((e) => e.exerciseId === exerciseId)?.sets ?? []);
    if (sets.length > 0) best = { at, sets };
  }
  return best?.sets ?? [];
}

export interface PastPlanItem {
  exerciseId: string;
  /** Séries prévues (modèle) ; bornées à 1–20. */
  sets: number;
  targetReps: number;
  targetRpe: number;
  group?: string;
}

/**
 * Exercices pré-remplis d'une séance passée (modèle) : nombre de séries du modèle,
 * reps et RPE visés, charge (ou durée) de la dernière fois AVANT cette date.
 * Les heures des séries sont réparties dans la durée de la séance.
 */
export function pastSessionEntries(
  plan: readonly PastPlanItem[],
  history: readonly DatedSession[],
  start: Date,
  durationMin: number,
): Array<{ exerciseId: string; sets: EditableSet[]; group?: string }> {
  const beforeMs = start.getTime();
  const counts = plan.map((p) => Math.max(1, Math.min(20, Math.round(Number(p.sets) || 1))));
  const total = counts.reduce((a, b) => a + b, 0);
  const step = (Math.max(1, durationMin) * 60_000) / (total + 1);
  let k = 0;
  return plan.map((p, i) => {
    const ref = lastWorkSets(history, p.exerciseId, beforeMs);
    const sets = Array.from({ length: counts[i]! }, (_, j): EditableSet => {
      const last = ref[Math.min(j, ref.length - 1)];
      const timed = !!last && isTimedSet(last);
      k += 1;
      return {
        setIndex: j,
        weightKg: last?.weightKg ?? 0,
        reps: timed ? 0 : Math.max(1, Math.round(Number(p.targetReps) || 8)),
        rpe: Number(p.targetRpe) >= 6 && Number(p.targetRpe) <= 10 ? Number(p.targetRpe) : 8,
        ...(timed && last.durationSec ? { durationSec: last.durationSec } : {}),
        ...(timed && last.distanceM ? { distanceM: last.distanceM } : {}),
        performedAt: new Date(beforeMs + Math.round(step * k)).toISOString(),
      };
    });
    return { exerciseId: p.exerciseId, sets, ...(p.group ? { group: p.group } : {}) };
  });
}

/** Séance passée terminée : début, fin et durée cohérents. */
export function buildPastSession<E>(input: {
  id: string;
  name: string;
  templateId?: string;
  start: Date;
  durationMin: number;
  entries: readonly E[];
}): {
  id: string;
  name: string;
  templateId?: string;
  startedAt: string;
  endedAt: string;
  durationMin: number;
  entries: readonly E[];
} {
  const startMs = input.start.getTime();
  return {
    id: input.id,
    name: input.name,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(startMs + input.durationMin * 60_000).toISOString(),
    durationMin: input.durationMin,
    entries: input.entries,
  };
}

/**
 * Ajoute (ou remplace, même identifiant) une séance à sa place dans l'historique
 * trié par date de début (plus ancienne d'abord). Les autres séances sont gardées.
 */
export function upsertSessionByDate<T extends { id: string; startedAt: string }>(
  sessions: readonly T[],
  session: T,
): T[] {
  return [...sessions.filter((s) => s.id !== session.id), session].sort((a, b) =>
    a.startedAt === b.startedAt
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.startedAt < b.startedAt
        ? -1
        : 1,
  );
}
