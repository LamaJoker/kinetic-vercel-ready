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

export async function loadSessions(storage: StoragePort): Promise<WorkoutSession[]> {
  const data = await storage.get<WorkoutSession[]>(KEY_SESSIONS);
  return Array.isArray(data) ? data : [];
}

export async function saveSessions(
  storage: StoragePort,
  sessions: WorkoutSession[],
): Promise<void> {
  // Idem saveTemplates : neutralise les proxies Alpine avant le structured-clone IDB.
  await storage.set(KEY_SESSIONS, JSON.parse(JSON.stringify(sessions)));
}
