/**
 * Import — parse les exports de Strong / Hevy / Kinetic et fusionne dans le
 * stockage local sans perdre les données existantes.
 *
 * Trois formats reconnus :
 *   - Kinetic JSON (sortie de `buildJsonExport`, version 1)
 *   - Strong CSV  (Date,Workout Name,Exercise Name,Set Order,Weight,Reps,…,RPE)
 *   - Hevy CSV    (title,start_time,end_time,…,exercise_title,…,weight_kg,reps,…,rpe)
 *
 * Politique de fusion :
 *   - Sessions  : dédupliquées par `id`. En cas d'absence d'id (CSV externe),
 *     un id stable est dérivé du couple (startedAt + nom). Une session existante
 *     n'est pas écrasée — on ignore le doublon (l'utilisateur peut réinitialiser
 *     puis ré-importer s'il veut tout remplacer).
 *   - Exercices : auto-création si inconnu, slug stable (kebab-case).
 *   - Séries chronométrées / de distance (gainage, cardio, farmer walk) :
 *     colonnes Seconds / Distance (Strong) et duration_seconds / distance_km
 *     (Hevy) → `durationSec` / `distanceM` avec `reps` à 0 ; l'exercice créé
 *     reçoit la mesure correspondante (`time` ou `distance`).
 *
 * Conçu pour être testable sans I/O : `parse*` retournent un ImportBundle
 * immuable, `mergeIntoStorage` applique le bundle au StoragePort fourni.
 */

import type { StoragePort } from '@kinetic/core';
import { STORAGE_KEYS, orderSetEntries } from '@kinetic/core';
import type { Exercise, WorkoutSession, SessionExerciseEntry, SetEntry } from './types';
import {
  loadCustomExercises,
  loadExercises,
  loadSessions,
  saveCustomExercises,
  saveExercises,
  saveSessions,
} from './storage';

export interface ImportBundle {
  sessions: readonly WorkoutSession[];
  exercises: readonly Exercise[];
  /** Exercices détectés mais à fusionner (créés si inconnus). */
  createdExercises: readonly Exercise[];
  /** Sauvegarde complète (export JSON version 2) : autres données de l'application. */
  data?: Record<string, unknown>;
}

export interface ImportReport {
  source: 'kinetic-json' | 'strong-csv' | 'hevy-csv';
  parsedSessions: number;
  importedSessions: number; // sessions effectivement ajoutées (hors doublons)
  duplicateSessions: number;
  createdExercises: number;
  skippedRows: number;
}

// ─── Détection du format ─────────────────────────────────────────────────────

export type ImportFormat = ImportReport['source'];

export function detectFormat(content: string): ImportFormat {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'kinetic-json';
  // Hevy a une colonne "weight_kg" (underscore), Strong utilise "Weight" en titre
  // et a une colonne "Workout Name". On regarde la première ligne (header).
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
  if (/weight_kg|exercise_title|set_index/.test(firstLine)) return 'hevy-csv';
  return 'strong-csv';
}

// ─── Kinetic JSON ────────────────────────────────────────────────────────────

export function parseKineticJson(content: string): ImportBundle {
  const data = JSON.parse(content);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const exercises = Array.isArray(data?.exercises) ? data.exercises : [];
  const extra = data?.data;
  const hasData = extra !== null && typeof extra === 'object' && !Array.isArray(extra);
  return {
    sessions: sessions.filter(isValidSession),
    exercises: exercises.filter(isValidExercise),
    createdExercises: [],
    ...(hasData ? { data: extra as Record<string, unknown> } : {}),
  };
}

function isValidSession(value: unknown): value is WorkoutSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.startedAt === 'string' &&
    Array.isArray(v.entries)
  );
}

function isValidExercise(value: unknown): value is Exercise {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.muscles);
}

// ─── CSV parsing utilitaires ─────────────────────────────────────────────────

/**
 * parseCsv — parseur RFC 4180 minimaliste mais correct.
 * Gère : guillemets, virgules échappées (""), retours à la ligne CRLF/LF.
 * Ne supporte pas les délimiteurs custom (tab, point-virgule) — Strong/Hevy = `,`.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // Retire le BOM UTF-8 éventuel (présent dans nos propres exports CSV)
  const text = content.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  // Dernière cellule / dernière ligne (fichier sans \n final)
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Filtre les lignes vides (parfois un \n final laisse [''])
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// ─── Strong CSV ──────────────────────────────────────────────────────────────

/**
 * Strong (iOS/Android) — colonnes en français-anglais selon la locale, mais
 * l'en-tête anglais est universel à l'export. Format de date local :
 *   "2025-12-01 18:32:48"
 */
export function parseStrongCsv(content: string): { bundle: ImportBundle; skipped: number } {
  const rows = parseCsv(content);
  if (rows.length < 2) return { bundle: emptyBundle(), skipped: 0 };

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.indexOf('date'),
    workoutName: header.indexOf('workout name'),
    exerciseName: header.indexOf('exercise name'),
    setOrder: header.indexOf('set order'),
    weight: findColumn(header, 'weight'),
    reps: header.indexOf('reps'),
    rpe: header.indexOf('rpe'),
    duration: header.indexOf('workout duration'),
    seconds: findColumn(header, 'seconds'),
    distance: findColumn(header, 'distance'),
  };
  // Unités d'après l'en-tête (« Weight (lbs) », « Distance (mi) ») ; Strong
  // exporte sinon dans les unités métriques : kg et km.
  const weightFactor = unitFactor(header[idx.weight] ?? '', { lbs: LB_TO_KG, lb: LB_TO_KG }, 1);
  const distanceFactor = unitFactor(
    header[idx.distance] ?? '',
    { mi: MI_TO_M, km: 1000, m: 1 },
    1000,
  );

  // sessionKey = `${date} ${workoutName}` → regroupe sets en sessions
  const sessionMap = new Map<string, MutableSession>();
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const date = pick(r, idx.date);
    const workoutName = pick(r, idx.workoutName) || 'Strong session';
    const exerciseName = pick(r, idx.exerciseName);
    const weight = Number(pick(r, idx.weight)) * weightFactor;
    const rpeRaw = Number(pick(r, idx.rpe));
    const setOrderRaw = pick(r, idx.setOrder);
    const setOrder = Math.max(0, Number(setOrderRaw) - 1);
    const measured = measuredSet(
      pick(r, idx.reps),
      pick(r, idx.seconds),
      pick(r, idx.distance),
      distanceFactor,
    );

    // Lignes « Rest Timer » des exports Strong récents : pas une série.
    if (!date || !exerciseName || !measured || /rest/i.test(setOrderRaw)) {
      skipped++;
      continue;
    }

    const performedAt = parseLocalDateTime(date);
    const sessionKey = `${date}|${workoutName}`;
    const session = sessionMap.get(sessionKey) ?? createMutableSession(performedAt, workoutName);
    sessionMap.set(sessionKey, session);

    const exId = slugify(exerciseName);
    let entry = session.entries.find((e) => e.exerciseId === exId);
    if (!entry) {
      entry = { exerciseId: exId, sets: [] };
      session.entries.push(entry);
    }
    entry.sets.push({
      setIndex: Number.isFinite(setOrder) ? setOrder : entry.sets.length,
      ...measured,
      weightKg: Number.isFinite(weight) ? roundKg(weight) : 0,
      rpe: clamp(Number.isFinite(rpeRaw) && rpeRaw > 0 ? rpeRaw : 7, 6, 10),
      performedAt,
      // Strong note les échauffements « W » dans « Set Order ».
      ...(setOrderRaw.toUpperCase() === 'W' ? { kind: 'warmup' as const } : {}),
    });
    session.exerciseNames.set(exId, exerciseName);
  }

  return finalizeMutableSessions(sessionMap, skipped);
}

// ─── Hevy CSV ────────────────────────────────────────────────────────────────

export function parseHevyCsv(content: string): { bundle: ImportBundle; skipped: number } {
  const rows = parseCsv(content);
  if (rows.length < 2) return { bundle: emptyBundle(), skipped: 0 };

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = {
    title: header.indexOf('title'),
    startTime: header.indexOf('start_time'),
    exerciseTitle: header.indexOf('exercise_title'),
    setIndex: header.indexOf('set_index'),
    weight: header.indexOf('weight_kg'),
    weightLbs: header.indexOf('weight_lbs'),
    reps: header.indexOf('reps'),
    rpe: header.indexOf('rpe'),
    setType: header.indexOf('set_type'),
    seconds: header.indexOf('duration_seconds'),
    distanceKm: header.indexOf('distance_km'),
    distanceMi: header.indexOf('distance_miles'),
  };

  const sessionMap = new Map<string, MutableSession>();
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const title = pick(r, idx.title) || 'Hevy session';
    const start = pick(r, idx.startTime);
    const exerciseName = pick(r, idx.exerciseTitle);
    const weight =
      idx.weight >= 0 ? Number(pick(r, idx.weight)) : Number(pick(r, idx.weightLbs)) * LB_TO_KG;
    const rpeRaw = Number(pick(r, idx.rpe));
    const setIdx = Number(pick(r, idx.setIndex));
    const measured =
      idx.distanceKm >= 0 || idx.distanceMi < 0
        ? measuredSet(pick(r, idx.reps), pick(r, idx.seconds), pick(r, idx.distanceKm), 1000)
        : measuredSet(pick(r, idx.reps), pick(r, idx.seconds), pick(r, idx.distanceMi), MI_TO_M);

    if (!start || !exerciseName || !measured) {
      skipped++;
      continue;
    }

    const performedAt = parseLocalDateTime(start);
    const sessionKey = `${start}|${title}`;
    const session = sessionMap.get(sessionKey) ?? createMutableSession(performedAt, title);
    sessionMap.set(sessionKey, session);

    const exId = slugify(exerciseName);
    let entry = session.entries.find((e) => e.exerciseId === exId);
    if (!entry) {
      entry = { exerciseId: exId, sets: [] };
      session.entries.push(entry);
    }
    entry.sets.push({
      setIndex: Number.isFinite(setIdx) ? setIdx : entry.sets.length,
      ...measured,
      weightKg: Number.isFinite(weight) ? roundKg(weight) : 0,
      rpe: clamp(Number.isFinite(rpeRaw) && rpeRaw > 0 ? rpeRaw : 7, 6, 10),
      performedAt,
      ...(pick(r, idx.setType).toLowerCase() === 'warmup' ? { kind: 'warmup' as const } : {}),
    });
    session.exerciseNames.set(exId, exerciseName);
  }

  return finalizeMutableSessions(sessionMap, skipped);
}

// ─── Fusion dans le storage ──────────────────────────────────────────────────

export async function mergeIntoStorage(
  storage: StoragePort,
  bundle: ImportBundle,
  source: ImportFormat,
): Promise<ImportReport> {
  const [existingSessions, existingExercises] = await Promise.all([
    loadSessions(storage),
    loadExercises(storage),
  ]);

  const existingSessionIds = new Set(existingSessions.map((s) => s.id));
  const existingExerciseIds = new Set(existingExercises.map((e) => e.id));

  const newSessions: WorkoutSession[] = [];
  let duplicates = 0;
  for (const s of bundle.sessions) {
    if (existingSessionIds.has(s.id)) {
      duplicates++;
      continue;
    }
    newSessions.push(s);
    existingSessionIds.add(s.id);
  }

  const newExercises: Exercise[] = [];
  const allFromBundle = [...bundle.exercises, ...bundle.createdExercises];
  for (const e of allFromBundle) {
    if (existingExerciseIds.has(e.id)) continue;
    newExercises.push(e);
    existingExerciseIds.add(e.id);
  }

  if (newSessions.length > 0) {
    await saveSessions(storage, newSessions);
  }
  if (newExercises.length > 0) {
    await saveExercises(storage, [...existingExercises, ...newExercises]);
    // Exercices perso d'une autre sauvegarde Kinetic : rangés avec ceux de l'utilisateur.
    const custom = newExercises.filter((e) => e.custom);
    if (custom.length > 0) {
      await saveCustomExercises(storage, [...(await loadCustomExercises(storage)), ...custom]);
    }
  }

  // Notifier les stores réactifs (goals, xp) qu'un batch de sessions a atterri.
  if (typeof window !== 'undefined' && newSessions.length > 0) {
    for (const s of newSessions) {
      window.dispatchEvent(
        new CustomEvent(STORAGE_KEYS.EVENT_SESSION_SAVED, { detail: { session: s } }),
      );
    }
  }

  return {
    source,
    parsedSessions: bundle.sessions.length,
    importedSessions: newSessions.length,
    duplicateSessions: duplicates,
    createdExercises: newExercises.length,
    skippedRows: 0, // les skipped CSV sont retournés en amont
  };
}

// ─── Helpers internes ────────────────────────────────────────────────────────

interface MutableSession {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  entries: Array<{ exerciseId: string; sets: SetEntry[] }>;
  exerciseNames: Map<string, string>;
}

function createMutableSession(startedAt: string, name: string): MutableSession {
  return {
    // id déterministe : permet la déduplication entre imports répétés du même CSV
    id: `import-${hash(startedAt + '|' + name)}`,
    name,
    startedAt,
    entries: [],
    exerciseNames: new Map(),
  };
}

function finalizeMutableSessions(
  map: Map<string, MutableSession>,
  skipped: number,
): { bundle: ImportBundle; skipped: number } {
  const sessions: WorkoutSession[] = [];
  const exercisesById = new Map<string, Exercise>();

  for (const s of map.values()) {
    if (s.entries.length === 0) continue;
    // endedAt = max performedAt
    const allPerformedAt = s.entries.flatMap((e) => e.sets.map((set) => set.performedAt)).sort();
    const endedAt = allPerformedAt[allPerformedAt.length - 1] ?? s.startedAt;
    sessions.push({
      id: s.id,
      name: s.name,
      startedAt: s.startedAt,
      endedAt,
      entries: s.entries.map(
        (e): SessionExerciseEntry => ({
          exerciseId: e.exerciseId,
          // Échauffements (« W » de Strong, sans numéro) d'abord, puis numérotation
          // contiguë : pas de setIndex en double (clés d'affichage uniques).
          sets: orderSetEntries([...e.sets].sort((a, b) => a.setIndex - b.setIndex)),
        }),
      ),
    });
    for (const [id, name] of s.exerciseNames) {
      if (!exercisesById.has(id)) {
        const sets = s.entries.find((e) => e.exerciseId === id)?.sets ?? [];
        const measure = importedMeasure(sets);
        exercisesById.set(id, {
          id,
          name,
          muscles: [],
          equipment: 'other',
          incrementKg: 2.5,
          ...(measure ? { measure } : {}),
        });
      }
    }
  }

  return {
    bundle: {
      sessions,
      exercises: [],
      createdExercises: [...exercisesById.values()],
    },
    skipped,
  };
}

const LB_TO_KG = 0.45359237;
const MI_TO_M = 1609.344;

/** Colonne « name » ou « name (unité) » (en-têtes Strong récents). */
function findColumn(header: readonly string[], name: string): number {
  const exact = header.indexOf(name);
  if (exact >= 0) return exact;
  return header.findIndex((h) => h.startsWith(`${name} (`));
}

/** Facteur d'unité lu entre parenthèses dans l'en-tête, sinon `fallback`. */
function unitFactor(header: string, units: Record<string, number>, fallback: number): number {
  const unit = /\(([a-z]+)\)\s*$/.exec(header)?.[1];
  return unit && unit in units ? units[unit]! : fallback;
}

function roundKg(kg: number): number {
  return Math.round(kg * 100) / 100;
}

/**
 * Série importée : en répétitions si `reps` > 0, sinon chronométrée
 * (`seconds`) et/ou de distance (`distance` × `distanceFactor` → mètres).
 * null si la ligne ne décrit aucune série exploitable.
 */
export function measuredSet(
  repsRaw: string,
  secondsRaw: string,
  distanceRaw: string,
  distanceFactor: number,
): { reps: number; durationSec?: number; distanceM?: number } | null {
  const reps = Number(repsRaw);
  if (repsRaw !== '' && Number.isFinite(reps) && reps > 0) return { reps };
  const seconds = Number(secondsRaw);
  const distance = Number(distanceRaw) * distanceFactor;
  const hasTime = secondsRaw !== '' && Number.isFinite(seconds) && seconds > 0;
  const hasDistance = distanceRaw !== '' && Number.isFinite(distance) && distance > 0;
  if (!hasTime && !hasDistance) return null;
  return {
    reps: 0,
    ...(hasTime ? { durationSec: Math.round(seconds) } : {}),
    ...(hasDistance ? { distanceM: Math.round(distance) } : {}),
  };
}

/** Mesure d'un exercice importé : distance ou temps si toutes ses séries le sont. */
export function importedMeasure(sets: readonly SetEntry[]): 'time' | 'distance' | undefined {
  if (sets.length === 0 || sets.some((x) => x.reps > 0)) return undefined;
  if (sets.some((x) => (x.distanceM ?? 0) > 0)) return 'distance';
  if (sets.some((x) => (x.durationSec ?? 0) > 0)) return 'time';
  return undefined;
}

function emptyBundle(): ImportBundle {
  return { sessions: [], exercises: [], createdExercises: [] };
}

function pick(row: string[], idx: number): string {
  if (idx < 0) return '';
  return (row[idx] ?? '').trim();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * parseLocalDateTime — "2025-12-01 18:32:48" → ISO en assumant le fuseau local.
 * Strong et Hevy exportent en heure locale sans timezone.
 */
export function parseLocalDateTime(text: string): string {
  // Format ISO-like avec espace : "YYYY-MM-DD HH:MM:SS"
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return date.toISOString();
  }
  // Format date seul : "YYYY-MM-DD"
  const d = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    const date = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    return date.toISOString();
  }
  // Fallback : laisser Date deviner (ISO complet, etc.)
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * hash — FNV-1a 32 bits, suffisant pour dédupliquer un id de session entre
 * imports répétés (collision improbable à l'échelle d'un utilisateur).
 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
