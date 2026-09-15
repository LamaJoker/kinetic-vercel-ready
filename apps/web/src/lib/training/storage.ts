import type { StoragePort } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';
import type { Exercise, WorkoutSession, WorkoutTemplate } from './types';
import { DEFAULT_EXERCISES, DEFAULT_TEMPLATES } from './seed';

const KEY_EXERCISES = STORAGE_KEYS.TRAINING_EXERCISES;
const KEY_TEMPLATES = STORAGE_KEYS.TRAINING_TEMPLATES;
const KEY_SESSIONS = STORAGE_KEYS.TRAINING_SESSIONS;
const EXERCISES_FETCH_TIMEOUT_MS = 8000;

export async function loadExercises(storage: StoragePort): Promise<Exercise[]> {
  const data = await storage.get<Exercise[]>(KEY_EXERCISES);
  if (Array.isArray(data) && data.length > 0) return data;

  // Try to bootstrap from a static exercise catalog (can contain 1000+ exercises)
  // without bundling it into JS. Falls back to a small seed list if missing.
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), EXERCISES_FETCH_TIMEOUT_MS);
    const res = await fetch('/exercises.v1.json', {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json) && json.length > 0) {
        const normalized = json
          .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
          .map((x) => ({
            id: String(x['id'] ?? ''),
            name: String(x['name'] ?? ''),
            muscles: Array.isArray(x['muscles']) ? (x['muscles'] as unknown[]).map(String) : [],
            equipment: (x['equipment'] ?? 'other') as Exercise['equipment'],
            incrementKg: Number.isFinite(Number(x['incrementKg'])) ? Number(x['incrementKg']) : 2.5,
          }))
          .filter((x) => x.id && x.name);

        if (normalized.length > 0) {
          await storage.set(KEY_EXERCISES, normalized);
          return normalized;
        }
      }
    }
  } catch {
    // ignore, fallback below
  }

  await storage.set(KEY_EXERCISES, [...DEFAULT_EXERCISES]);
  return [...DEFAULT_EXERCISES];
}

export async function saveExercises(storage: StoragePort, exercises: Exercise[]): Promise<void> {
  await storage.set(KEY_EXERCISES, exercises);
}

export async function loadTemplates(storage: StoragePort): Promise<WorkoutTemplate[]> {
  const data = await storage.get<WorkoutTemplate[]>(KEY_TEMPLATES);
  if (Array.isArray(data) && data.length > 0) return data;
  await storage.set(KEY_TEMPLATES, [...DEFAULT_TEMPLATES]);
  return [...DEFAULT_TEMPLATES];
}

export async function saveTemplates(
  storage: StoragePort,
  templates: WorkoutTemplate[],
): Promise<void> {
  // JSON round-trip = unwrap Alpine reactive proxies before structured-clone (IDB).
  // Without ça, Safari/Firefox lèvent DataCloneError sur les Proxy objects.
  await storage.set(KEY_TEMPLATES, JSON.parse(JSON.stringify(templates)));
}

// ─── Séances : une clé par séance ────────────────────────────────────────────
//
// Historiquement toutes les séances vivaient dans un tableau unique
// (`kinetic:training:sessions`). Problèmes : limite 1 MB par valeur (IDB et
// Supabase) atteinte après quelques centaines de séances, historique complet
// ré-uploadé à chaque série, et conflit Last-Write-Wins sur tout l'historique
// quand deux appareils ajoutent chacun une séance.
//
// Désormais : `kinetic:training:session:<id>`. Le tableau legacy est « replié »
// automatiquement (migration v2 + filet de sécurité à la lecture).

const LEGACY_SESSIONS_KEY = KEY_SESSIONS;
const SESSION_PREFIX = STORAGE_KEYS.TRAINING_SESSION_PREFIX;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,150}$/;

function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Clé de stockage d'une séance (id assaini pour respecter /^[a-zA-Z0-9:_-]{1,200}$/). */
export function sessionStorageKey(id: string): string {
  if (SAFE_ID.test(id)) return STORAGE_KEYS.TRAINING_SESSION(id);
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return STORAGE_KEYS.TRAINING_SESSION(`${cleaned}_${shortHash(id)}`);
}

function isSession(value: unknown): value is WorkoutSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WorkoutSession>;
  return typeof v.id === 'string' && typeof v.startedAt === 'string' && Array.isArray(v.entries);
}

/** Neutralise les proxies Alpine avant le structured-clone IDB (DataCloneError Safari/Firefox). */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byStartedAt(a: WorkoutSession, b: WorkoutSession): number {
  if (a.startedAt === b.startedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.startedAt < b.startedAt ? -1 : 1;
}

const foldInflight = new WeakMap<StoragePort, Promise<number>>();

/**
 * foldLegacySessions — déplace le tableau legacy vers une clé par séance.
 * N'écrase jamais une séance déjà stockée au nouveau format (plus récente).
 * Idempotent et dédoublonné par instance de storage.
 * @returns nombre de séances déplacées.
 */
export function foldLegacySessions(storage: StoragePort): Promise<number> {
  const existing = foldInflight.get(storage);
  if (existing) return existing;

  const run = (async () => {
    const legacy = await storage.get<unknown>(LEGACY_SESSIONS_KEY);
    if (legacy === null || legacy === undefined) return 0;

    let moved = 0;
    if (Array.isArray(legacy)) {
      for (const candidate of legacy) {
        if (!isSession(candidate)) continue;
        const key = sessionStorageKey(candidate.id);
        if ((await storage.get(key)) !== null) continue;
        await storage.set(key, plain(candidate));
        moved++;
      }
    }
    // Suppression seulement après que toutes les écritures ont réussi.
    await storage.remove(LEGACY_SESSIONS_KEY);
    return moved;
  })();

  foldInflight.set(storage, run);
  return run.finally(() => foldInflight.delete(storage));
}

export async function loadSessions(storage: StoragePort): Promise<WorkoutSession[]> {
  try {
    await foldLegacySessions(storage);
  } catch (err) {
    console.warn('[training] legacy sessions fold failed:', err);
  }

  const keys = (await storage.keys()).filter((k) => k.startsWith(SESSION_PREFIX));
  const values = await Promise.all(keys.map((k) => storage.get<unknown>(k)));
  const sessions = values.filter(isSession);

  // Filet : si le fold a échoué, on lit quand même le legacy (sans doublons).
  const legacy = await storage.get<unknown>(LEGACY_SESSIONS_KEY);
  if (Array.isArray(legacy)) {
    const ids = new Set(sessions.map((s) => s.id));
    for (const s of legacy) if (isSession(s) && !ids.has(s.id)) sessions.push(s);
  }

  return sessions.sort(byStartedAt);
}

/** Crée ou met à jour UNE séance (seule sa clé est écrite / synchronisée). */
export async function saveSession(storage: StoragePort, session: WorkoutSession): Promise<void> {
  await storage.set(sessionStorageKey(session.id), plain(session));
}

/** Supprime UNE séance (la suppression est propagée au cloud). */
export async function deleteSession(storage: StoragePort, id: string): Promise<void> {
  await storage.remove(sessionStorageKey(id));
}

/**
 * saveSessions — upsert d'un lot de séances. Ne supprime JAMAIS les séances
 * absentes de la liste : une lecture partielle ne peut plus effacer l'historique.
 * Pour supprimer, utiliser `deleteSession`.
 */
export async function saveSessions(
  storage: StoragePort,
  sessions: WorkoutSession[],
): Promise<void> {
  for (const session of sessions) {
    if (isSession(session)) await saveSession(storage, session);
  }
}
