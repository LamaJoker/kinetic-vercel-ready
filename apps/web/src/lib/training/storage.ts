import type { StoragePort } from '@kinetic/core';
import {
  EXERCISE_CATALOG_VERSION,
  STORAGE_KEYS,
  mergeCatalog,
  mergeExerciseLists,
  needsCatalogUpdate,
} from '@kinetic/core';
import type { Exercise, WorkoutSession, WorkoutTemplate } from './types';
import { DEFAULT_EXERCISES, DEFAULT_TEMPLATES } from './seed';
import { underlyingStorage } from '../write-journal';
import { localizeExercises } from './exercise-names-fr';

const KEY_EXERCISES = STORAGE_KEYS.TRAINING_EXERCISES;
const KEY_TEMPLATES = STORAGE_KEYS.TRAINING_TEMPLATES;
const KEY_SESSIONS = STORAGE_KEYS.TRAINING_SESSIONS;
const EXERCISES_FETCH_TIMEOUT_MS = 8000;

const KEY_CUSTOM_EXERCISES = STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES;
const KEY_CATALOG_VERSION = STORAGE_KEYS.TRAINING_CATALOG_VERSION;

/** Catalogue + exercices de l'utilisateur (ces derniers survivent à toute mise à jour du catalogue). */
export async function loadExercises(storage: StoragePort): Promise<Exercise[]> {
  const [catalog, custom] = await Promise.all([
    loadCatalogExercises(storage),
    loadCustomExercises(storage),
  ]);
  return mergeExerciseLists(catalog, custom);
}

/** Exercices créés par l'utilisateur (marqués custom: true), masqués compris. */
export async function loadCustomExercises(storage: StoragePort): Promise<Exercise[]> {
  const data = await storage.get<Exercise[]>(KEY_CUSTOM_EXERCISES);
  return Array.isArray(data)
    ? data.filter((e) => e && e.id).map((e) => ({ ...e, custom: true }))
    : [];
}

export async function saveCustomExercises(storage: StoragePort, list: Exercise[]): Promise<void> {
  await storage.set(KEY_CUSTOM_EXERCISES, JSON.parse(JSON.stringify(list)));
}

/** Stockages dont la mise à jour du catalogue a déjà été tentée (évite de re-télécharger hors ligne). */
const catalogAttempted = new WeakSet<StoragePort>();

async function loadCatalogExercises(storage: StoragePort): Promise<Exercise[]> {
  const [data, version] = await Promise.all([
    storage.get<Exercise[]>(KEY_EXERCISES),
    storage.get<number>(KEY_CATALOG_VERSION),
  ]);
  const stored = Array.isArray(data) ? data.filter((e) => e && e.id) : [];
  if (stored.length > 0 && (catalogAttempted.has(storage) || !needsCatalogUpdate(version))) {
    return localizeExercises(stored);
  }
  catalogAttempted.add(storage);

  // Catalogue statique (hors bundle JS) : premier lancement ou nouvelle version.
  // Fusion par id : ajouts/corrections appliqués, le reste de la liste stockée conservé.
  const fresh = await fetchCatalog();
  if (fresh.length > 0) {
    const merged = mergeCatalog(stored, fresh);
    await storage.set(KEY_EXERCISES, merged);
    await storage.set(KEY_CATALOG_VERSION, EXERCISE_CATALOG_VERSION);
    return localizeExercises(merged);
  }
  if (stored.length > 0) return localizeExercises(stored);

  // Catalogue indisponible : catalogue embarqué en mémoire, sans l'écrire (sync.md § 4.6).
  return localizeExercises([...DEFAULT_EXERCISES]);
}

async function fetchCatalog(): Promise<Exercise[]> {
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), EXERCISES_FETCH_TIMEOUT_MS);
    const res = await fetch('/exercises.v1.json', {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const json: unknown = await res.json();
    if (!Array.isArray(json)) return [];
    return json
      .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
      .map((x) => ({
        id: String(x['id'] ?? ''),
        name: String(x['name'] ?? ''),
        muscles: Array.isArray(x['muscles']) ? (x['muscles'] as unknown[]).map(String) : [],
        equipment: (x['equipment'] ?? 'other') as Exercise['equipment'],
        incrementKg: Number.isFinite(Number(x['incrementKg'])) ? Number(x['incrementKg']) : 2.5,
        // Mesure explicite du catalogue (sinon déduite à l'usage : exerciseMeasure).
        ...(x['measure'] === 'time' || x['measure'] === 'distance'
          ? { measure: x['measure'] as 'time' | 'distance' }
          : {}),
      }))
      .filter((x) => x.id && x.name);
  } catch {
    return [];
  }
}

/** Enregistre le catalogue. Les exercices perso (custom) ont leur propre clé : ils sont écartés ici. */
export async function saveExercises(storage: StoragePort, exercises: Exercise[]): Promise<void> {
  await storage.set(
    KEY_EXERCISES,
    exercises.filter((e) => !e.custom),
  );
}

/**
 * Modèles de séance. `null` (clé absente) → modèles par défaut EN MÉMOIRE, jamais
 * écrits : avant la première synchro, une écriture écraserait les modèles du compte
 * (audit qualité F3, sync.md § 4.6). Ils sont enregistrés à la première modification
 * (saveTemplates). Un échec de lecture est propagé (jamais traité comme « absent »).
 * Une liste vide est un choix de l'utilisateur (tous ses modèles supprimés) : respectée.
 */
export async function loadTemplates(storage: StoragePort): Promise<WorkoutTemplate[]> {
  const data = await storage.get<WorkoutTemplate[]>(KEY_TEMPLATES);
  if (Array.isArray(data)) return data;
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
 * Idempotent et dédoublonné par stockage (le journal de la migration v2 et la lecture
 * des séances partagent le même repli : jamais deux replis concurrents).
 * @returns nombre de séances déplacées.
 */
export function foldLegacySessions(storage: StoragePort): Promise<number> {
  const base = underlyingStorage(storage);
  const existing = foldInflight.get(base);
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

  foldInflight.set(base, run);
  return run.finally(() => foldInflight.delete(base));
}

/** Lecture des séances en cours, par stockage (appels simultanés regroupés). */
const sessionsInflight = new WeakMap<StoragePort, Promise<WorkoutSession[]>>();

/**
 * Dernière liste lue, par stockage réel (PERF-11) : à la lecture suivante, si la liste
 * des clés de séances n'a pas changé (une seule requête, `keys()`) et que rien ne l'a
 * invalidée, elle est resservie au lieu d'une requête IndexedDB par séance.
 *
 * Invalidation :
 *  - écritures de ce module (`saveSession`, `deleteSession`) : génération incrémentée ;
 *  - séance ajoutée ou supprimée par n'importe quel autre chemin (démo, import,
 *    restauration, repli de l'ancien format…) : la liste des clés diffère ;
 *  - synchro ou autre onglet (`EVENT_SYNC_APPLIED`, émis par SyncedStorage avec les
 *    clés modifiées) : contenu d'une séance existante remplacé sans changer les clés.
 * Chaque appel reçoit une COPIE : un appelant qui modifie sa liste ne touche ni le
 * cache ni les autres pages.
 */
interface SessionsCacheEntry {
  signature: string;
  generation: string;
  sessions: WorkoutSession[];
}
let sessionsCache = new WeakMap<StoragePort, SessionsCacheEntry>();
const sessionsGeneration = new WeakMap<StoragePort, number>();
/** Incrémenté quand TOUS les caches sont invalidés (synchro) : lectures en cours ignorées. */
let sessionsEpoch = 0;
let syncListenerInstalled = false;

/** Version des séances de ce stockage : change à chaque invalidation (lui seul ou tous). */
function generationOf(base: StoragePort): string {
  return `${sessionsEpoch}:${sessionsGeneration.get(base) ?? 0}`;
}

/**
 * Oublie la liste de séances gardée pour ce stockage (ou pour tous). À appeler après une
 * écriture de séance qui ne passe pas par `saveSession` / `deleteSession`.
 */
export function invalidateSessionsCache(storage?: StoragePort): void {
  if (!storage) {
    sessionsCache = new WeakMap();
    sessionsEpoch++;
    return;
  }
  const base = underlyingStorage(storage);
  sessionsCache.delete(base);
  sessionsInflight.delete(storage);
  sessionsInflight.delete(base);
  sessionsGeneration.set(base, (sessionsGeneration.get(base) ?? 0) + 1);
}

/** Une clé modifiée par la synchro concerne-t-elle les séances ? (liste vide = tout) */
export function syncTouchesSessions(keys: unknown): boolean {
  if (!Array.isArray(keys) || keys.length === 0) return true;
  return keys.some(
    (k) => typeof k !== 'string' || k.startsWith(SESSION_PREFIX) || k === LEGACY_SESSIONS_KEY,
  );
}

function installSyncListener(): void {
  if (syncListenerInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  syncListenerInstalled = true;
  window.addEventListener(STORAGE_KEYS.EVENT_SYNC_APPLIED, (e: Event) => {
    if (syncTouchesSessions((e as CustomEvent<{ keys?: unknown }>).detail?.keys)) {
      invalidateSessionsCache();
    }
  });
}

function cloneSessions(list: WorkoutSession[]): WorkoutSession[] {
  return typeof structuredClone === 'function'
    ? structuredClone(list)
    : (JSON.parse(JSON.stringify(list)) as WorkoutSession[]);
}

/**
 * Toutes les séances, triées par date de début. Au démarrage, l'accueil, les
 * objectifs et les succès les demandent en même temps : une seule lecture du
 * stockage est faite, les appels simultanés en reçoivent une copie. La liste lue
 * est gardée (copie à chaque appel) tant qu'elle reste valable (voir ci-dessus).
 */
export function loadSessions(storage: StoragePort): Promise<WorkoutSession[]> {
  installSyncListener();
  const pending = sessionsInflight.get(storage);
  if (pending) return pending.then(cloneSessions);
  const run = readSessions(storage);
  sessionsInflight.set(storage, run);
  const clear = (): void => {
    if (sessionsInflight.get(storage) === run) sessionsInflight.delete(storage);
  };
  run.then(clear, clear);
  return run;
}

async function readSessions(storage: StoragePort): Promise<WorkoutSession[]> {
  const base = underlyingStorage(storage);
  const generation = generationOf(base);
  try {
    await foldLegacySessions(storage);
  } catch (err) {
    console.warn('[training] legacy sessions fold failed:', err);
  }

  const keys = (await storage.keys()).filter((k) => k.startsWith(SESSION_PREFIX));
  const signature = [...keys].sort().join('\n');
  const cached = sessionsCache.get(base);
  if (cached && cached.signature === signature && cached.generation === generationOf(base)) {
    return cloneSessions(cached.sessions);
  }

  const values = await Promise.all(keys.map((k) => storage.get<unknown>(k)));
  const sessions = values.filter(isSession);

  // Filet : si le fold a échoué, on lit quand même le legacy (sans doublons).
  const legacy = await storage.get<unknown>(LEGACY_SESSIONS_KEY);
  let complete = true;
  if (Array.isArray(legacy)) {
    complete = false; // ancien format encore présent : rien n'est gardé
    const ids = new Set(sessions.map((s) => s.id));
    for (const s of legacy) if (isSession(s) && !ids.has(s.id)) sessions.push(s);
  }

  sessions.sort(byStartedAt);
  // Écriture ou synchro pendant la lecture : résultat servi, mais pas gardé.
  if (complete && generation === generationOf(base)) {
    sessionsCache.set(base, { signature, generation, sessions: cloneSessions(sessions) });
  }
  return sessions;
}

/** Crée ou met à jour UNE séance (seule sa clé est écrite / synchronisée). */
export async function saveSession(storage: StoragePort, session: WorkoutSession): Promise<void> {
  // Une lecture en cours ou gardée ne doit pas servir l'ancienne liste (avant ET après
  // l'écriture : une lecture lancée pendant l'écriture ne doit pas être gardée).
  invalidateSessionsCache(storage);
  try {
    await storage.set(sessionStorageKey(session.id), plain(session));
  } finally {
    invalidateSessionsCache(storage);
  }
}

/** Supprime UNE séance (la suppression est propagée au cloud). */
export async function deleteSession(storage: StoragePort, id: string): Promise<void> {
  invalidateSessionsCache(storage);
  try {
    await storage.remove(sessionStorageKey(id));
  } finally {
    invalidateSessionsCache(storage);
  }
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
