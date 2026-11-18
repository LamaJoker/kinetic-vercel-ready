/**
 * Type de mesure d'un exercice : répétitions × charge (par défaut), durée
 * (gainage, chaise, suspension) ou distance avec durée (farmer walk, traîneau,
 * cardio). Saisie, validation et records des séries chronométrées. Pur, zéro I/O.
 *
 * Rétro-compatible : un exercice sans `measure` est déduit de son identifiant
 * (catalogue) ou de son nom ; à défaut, il se mesure en répétitions. Une série
 * chronométrée garde `reps: 0` : elle ne pèse jamais dans le tonnage ni l'e1RM.
 */
import { isTimedSet, workSetsOf, type KindedSet, type TimedFields } from './workout-sets.domain.js';

export type ExerciseMeasure = 'reps' | 'time' | 'distance';

export const MEASURE_OPTIONS: ReadonlyArray<{ key: ExerciseMeasure; label: string }> = [
  { key: 'reps', label: 'Reps × charge' },
  { key: 'time', label: 'Durée' },
  { key: 'distance', label: 'Distance' },
];

export function isExerciseMeasure(value: unknown): value is ExerciseMeasure {
  return value === 'reps' || value === 'time' || value === 'distance';
}

/** Exercices du catalogue tenus en durée. */
const TIME_IDS = new Set(['plank', 'sideplan', 'l_sit', 'jumprope', 'battlerope']);
/** Exercices du catalogue mesurés en distance (et durée). */
const DISTANCE_IDS = new Set([
  'farmerswalk',
  'yoke_walk',
  'sandbag',
  'sled',
  'sprint',
  'bike',
  'rower',
  'treadmill',
  'elliptical',
  'assault_bike',
]);

const TIME_NAME =
  /\b(plank|planche|gainage|wall ?sit|chaise|dead ?hang|suspension|isom[ée]trique|hollow ?(body ?)?hold|l-?sit|corde [àa] sauter|jump ?rope|battle ?rope)\b/i;
const DISTANCE_NAME =
  /\b(farmer|carry|portage|marche|course|running|run|sprint|v[ée]lo|bike|rameur|row ?erg|rower|tapis|treadmill|elliptique|elliptical|sled|tra[iî]neau|natation|swim|yoke)\b/i;

export interface MeasurableExercise {
  id: string;
  name?: string;
  measure?: ExerciseMeasure | (string & {}) | undefined;
}

/**
 * Mesure d'un exercice : celle enregistrée, sinon déduite (catalogue, puis nom).
 * Les noms de répétitions (« Hanging Leg Raise », « Walking Lunges ») restent en reps.
 */
export function exerciseMeasure(ex: MeasurableExercise | null | undefined): ExerciseMeasure {
  if (!ex) return 'reps';
  if (isExerciseMeasure(ex.measure)) return ex.measure;
  if (TIME_IDS.has(ex.id)) return 'time';
  if (DISTANCE_IDS.has(ex.id)) return 'distance';
  const name = ex.name ?? '';
  if (TIME_NAME.test(name)) return 'time';
  if (DISTANCE_NAME.test(name)) return 'distance';
  return 'reps';
}

export function isTimedMeasure(measure: ExerciseMeasure): boolean {
  return measure !== 'reps';
}

/** Unité de saisie de la distance : mètres pour les portés et sprints, km pour le cardio. */
export function defaultDistanceUnit(ex: MeasurableExercise | null | undefined): 'm' | 'km' {
  if (!ex) return 'm';
  const short = new Set(['farmerswalk', 'yoke_walk', 'sandbag', 'sled', 'sprint']);
  if (short.has(ex.id)) return 'm';
  return /\b(farmer|carry|portage|sled|tra[iî]neau|sprint|yoke)\b/i.test(ex.name ?? '')
    ? 'm'
    : 'km';
}

/**
 * Durée saisie → secondes. Accepte « 1:30 », « 1'30 », « 1 min 30 », « 90 »
 * (secondes), « 1:02:05 ». NaN si illisible, 0 si vide.
 */
export function parseDuration(text: string | number | null | undefined): number {
  const t = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t.replace(',', '.'))) return Math.round(Number(t.replace(',', '.')));
  const colon = t.match(/^(\d{1,3})[:'’](\d{1,2})(?:[:'’](\d{1,2}))?"?$/);
  if (colon) {
    const [a, b, c] = [Number(colon[1]), Number(colon[2]), colon[3]];
    if (c !== undefined) return b < 60 && Number(c) < 60 ? a * 3600 + b * 60 + Number(c) : NaN;
    return b < 60 ? a * 60 + b : NaN;
  }
  const words = t.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*(?:min|mn|m)(?![a-z]))?\s*(?:(\d+)\s*s?)?$/);
  if (words && (words[1] || words[2] || words[3])) {
    return Number(words[1] ?? 0) * 3600 + Number(words[2] ?? 0) * 60 + Number(words[3] ?? 0);
  }
  return NaN;
}

/**
 * Distance saisie → mètres. « 400 », « 400 m », « 2,5 km », « 2.5km ».
 * Sans unité, `unit` s'applique. NaN si illisible, 0 si vide.
 */
export function parseDistance(
  text: string | number | null | undefined,
  unit: 'm' | 'km' = 'm',
): number {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(',', '.');
  if (!t) return 0;
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(km|m)?$/);
  if (!m) return NaN;
  const value = Number(m[1]);
  const u = m[2] ?? unit;
  return Math.round((u === 'km' ? value * 1000 : value) * 10) / 10;
}

/** Valeur d'un champ de distance dans l'unité choisie : 2500 m → « 2,5 » (km). */
export function distanceInputValue(m: number, unit: 'm' | 'km'): string {
  const v = Number(m) || 0;
  if (v <= 0) return '';
  const n = unit === 'km' ? Math.round(v / 10) / 100 : Math.round(v * 10) / 10;
  return String(n).replace('.', ',');
}

export interface TimedSetInput {
  durationSec: number;
  distanceM: number;
  weightKg: number;
  rpe: number;
}

/** Message d'erreur en français, ou null si la série chronométrée est valide. */
export function validateTimedSetInput(
  input: TimedSetInput,
  measure: ExerciseMeasure,
): string | null {
  const { durationSec, distanceM, weightKg, rpe } = input;
  if (!Number.isFinite(durationSec) || durationSec < 0 || durationSec > 86_400)
    return 'Durée invalide (m:ss, 24 h au plus).';
  if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > 1_000_000)
    return 'Distance invalide.';
  if (measure === 'distance') {
    if (durationSec <= 0 && distanceM <= 0) return 'Indique une distance ou une durée.';
  } else if (durationSec <= 0) {
    return 'Indique une durée (ex. 1:30).';
  }
  if (!Number.isFinite(weightKg) || weightKg < 0 || weightKg > 1000)
    return 'Charge invalide (0 à 1000 kg).';
  if (!Number.isFinite(rpe) || rpe < 6 || rpe > 10) return 'RPE invalide (6–10).';
  return null;
}

/** Champs d'une série chronométrée à enregistrer (reps à 0, champs vides omis). */
export function timedSetFields(input: TimedSetInput): {
  reps: 0;
  weightKg: number;
  rpe: number;
  durationSec?: number;
  distanceM?: number;
} {
  return {
    reps: 0,
    weightKg: input.weightKg,
    rpe: input.rpe,
    ...(input.durationSec > 0 ? { durationSec: Math.round(input.durationSec) } : {}),
    ...(input.distanceM > 0 ? { distanceM: input.distanceM } : {}),
  };
}

type MeasuredSet = KindedSet & TimedFields & { reps: number; weightKg: number };

/** Séries de travail en reps × charge (sans échauffement ni série chronométrée). */
export function loadSetsOf<T extends MeasuredSet>(sets: readonly T[]): T[] {
  return workSetsOf(sets).filter((s) => !isTimedSet(s) && Number(s.reps) > 0);
}

/** Séries de travail chronométrées ou de distance. */
export function timedSetsOf<T extends MeasuredSet>(sets: readonly T[]): T[] {
  return workSetsOf(sets).filter(isTimedSet);
}

export interface TimedBest {
  /** Meilleure durée (s), 0 sans série chronométrée. */
  durationSec: number;
  durationAt: string;
  /** Plus longue distance (m), 0 sans distance. */
  distanceM: number;
  distanceAt: string;
  /** Charge de la meilleure durée (kg). */
  weightKg: number;
}

interface SessionWithSets {
  startedAt: string;
  entries: ReadonlyArray<{
    exerciseId: string;
    sets: ReadonlyArray<MeasuredSet & { performedAt?: string }>;
  }>;
}

/**
 * Records chronométrés d'un exercice : plus longue durée et plus longue distance
 * (séries de travail seulement). null s'il n'y en a aucune.
 */
export function bestTimed(
  sessions: readonly SessionWithSets[],
  exerciseId: string,
): TimedBest | null {
  let best: TimedBest | null = null;
  for (const s of sessions) {
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of timedSetsOf(e.sets)) {
        const at = set.performedAt ?? s.startedAt;
        best ??= { durationSec: 0, durationAt: '', distanceM: 0, distanceAt: '', weightKg: 0 };
        const d = Number(set.durationSec) || 0;
        const m = Number(set.distanceM) || 0;
        if (d > best.durationSec) {
          best.durationSec = d;
          best.durationAt = at;
          best.weightKg = Number(set.weightKg) || 0;
        }
        if (m > best.distanceM) {
          best.distanceM = m;
          best.distanceAt = at;
        }
      }
    }
  }
  return best;
}

/** Records chronométrés de tous les exercices qui en ont (ordre d'apparition). */
export function timedRecords(
  sessions: readonly SessionWithSets[],
): Array<TimedBest & { exerciseId: string }> {
  const ids: string[] = [];
  for (const s of sessions)
    for (const e of s.entries)
      if (!ids.includes(e.exerciseId) && timedSetsOf(e.sets).length > 0) ids.push(e.exerciseId);
  return ids.map((exerciseId) => ({ exerciseId, ...bestTimed(sessions, exerciseId)! }));
}

/** Vrai si la série bat la meilleure durée (ou distance) précédente ; faux sans référence. */
export function isTimedRecord(set: TimedFields, previous: TimedBest | null): boolean {
  if (!previous) return false;
  const d = Number(set.durationSec) || 0;
  const m = Number(set.distanceM) || 0;
  return (
    (d > 0 && previous.durationSec > 0 && d > previous.durationSec) ||
    (m > 0 && previous.distanceM > 0 && m > previous.distanceM)
  );
}
