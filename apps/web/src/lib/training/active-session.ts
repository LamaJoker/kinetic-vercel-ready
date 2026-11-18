/**
 * Séance en cours persistée : sans ça, la séance n'existait qu'en mémoire et se
 * perdait au changement d'onglet, au rechargement ou quand iOS ferme l'app en
 * arrière-plan pendant un repos.
 *
 * On enregistre un instantané (séance + fin du repos en heure absolue, jamais un
 * compte à rebours) sous `TRAINING_ACTIVE_SESSION`, clé locale à l'appareil
 * (exclue de la synchro et des sauvegardes). La page Séances le reprend à
 * l'ouverture ; le bandeau « Séance en cours » le lit sur les autres écrans.
 */
import { STORAGE_KEYS } from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';
import type { WorkoutSession } from './types';

export const ACTIVE_SESSION_KEY = STORAGE_KEYS.TRAINING_ACTIVE_SESSION;
const SNAPSHOT_VERSION = 1;

/** Au-delà, on ne reprend pas sans demander (« Reprendre » ou « Abandonner »). */
export const ACTIVE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface ActiveSessionSnapshot {
  v: typeof SNAPSHOT_VERSION;
  session: WorkoutSession;
  /** Heure de fin du repos (ms epoch), 0 sans repos en cours. */
  restEndsAtMs: number;
  restTotalSec: number;
  restPresetSec: number;
  activeExerciseId: string | null;
  /** Dernière écriture (ms epoch). */
  savedAtMs: number;
}

export interface ActiveSessionState {
  session: WorkoutSession | null;
  restEndsAtMs: number;
  restTotalSec: number;
  restPresetSec: number;
  activeExerciseId: string | null;
}

/** Résumé diffusé au bandeau (évite une relecture du stockage à chaque série). */
export interface ActiveSessionSummary {
  name: string;
  startedAt: string;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Copie JSON pure (supprime les proxys Alpine, prête pour IndexedDB). */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Instantané à enregistrer, ou null s'il n'y a pas de séance (→ effacement). */
export function snapshotActiveSession(
  state: ActiveSessionState,
  nowMs: number,
): ActiveSessionSnapshot | null {
  if (!state.session) return null;
  const restEndsAtMs = finiteOr(state.restEndsAtMs, 0);
  return {
    v: SNAPSHOT_VERSION,
    session: plain(state.session),
    restEndsAtMs: restEndsAtMs > nowMs ? restEndsAtMs : 0,
    restTotalSec: finiteOr(state.restTotalSec, 90),
    restPresetSec: finiteOr(state.restPresetSec, 90),
    activeExerciseId: state.activeExerciseId ?? null,
    savedAtMs: nowMs,
  };
}

function isValidSession(value: unknown): value is WorkoutSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s['id'] !== 'string' || !s['id']) return false;
  if (typeof s['name'] !== 'string') return false;
  if (typeof s['startedAt'] !== 'string' || !Number.isFinite(Date.parse(s['startedAt'])))
    return false;
  if (s['endedAt']) return false; // déjà terminée : rien à reprendre
  if (!Array.isArray(s['entries'])) return false;
  return s['entries'].every(
    (e: unknown) =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as Record<string, unknown>)['exerciseId'] === 'string' &&
      Array.isArray((e as Record<string, unknown>)['sets']),
  );
}

/** Valide un instantané lu du stockage ; null s'il est absent ou corrompu. */
export function parseActiveSession(raw: unknown): ActiveSessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== SNAPSHOT_VERSION || !isValidSession(r['session'])) return null;
  const active = r['activeExerciseId'];
  return {
    v: SNAPSHOT_VERSION,
    session: r['session'],
    restEndsAtMs: Math.max(0, finiteOr(r['restEndsAtMs'], 0)),
    restTotalSec: Math.max(1, finiteOr(r['restTotalSec'], 90)),
    restPresetSec: Math.max(15, Math.min(600, finiteOr(r['restPresetSec'], 90))),
    activeExerciseId: typeof active === 'string' ? active : null,
    savedAtMs: finiteOr(r['savedAtMs'], 0),
  };
}

/** Vrai si la séance a commencé il y a plus de 12 h : on demande avant de reprendre. */
export function isActiveSessionStale(
  snap: ActiveSessionSnapshot,
  nowMs: number,
  maxAgeMs = ACTIVE_SESSION_MAX_AGE_MS,
): boolean {
  const started = Date.parse(snap.session.startedAt);
  return !Number.isFinite(started) || nowMs - started > maxAgeMs;
}

/** Secondes de repos restantes à l'instant `nowMs` (0 si le repos est fini). */
export function restRemainingAt(snap: ActiveSessionSnapshot, nowMs: number): number {
  return snap.restEndsAtMs > nowMs ? Math.ceil((snap.restEndsAtMs - nowMs) / 1000) : 0;
}

/** État à réinjecter dans la page Séances : repos terminé pendant l'absence → plus de repos. */
export function restoreActiveSession(
  snap: ActiveSessionSnapshot,
  nowMs: number,
): ActiveSessionState & { restRemainingSec: number } {
  const restRemainingSec = restRemainingAt(snap, nowMs);
  return {
    session: snap.session,
    restEndsAtMs: restRemainingSec > 0 ? snap.restEndsAtMs : 0,
    restTotalSec: Math.max(snap.restTotalSec, restRemainingSec),
    restPresetSec: snap.restPresetSec,
    activeExerciseId: snap.activeExerciseId,
    restRemainingSec,
  };
}

export function summarizeActiveSession(
  snap: Pick<ActiveSessionSnapshot, 'session'> | null,
): ActiveSessionSummary | null {
  return snap ? { name: snap.session.name, startedAt: snap.session.startedAt } : null;
}

/** « 4:05 » ou « 1:02:09 » depuis `startedAt`. */
export function formatActiveDuration(startedAt: string, nowMs: number): string {
  const start = Date.parse(startedAt);
  const sec = Number.isFinite(start) ? Math.max(0, Math.floor((nowMs - start) / 1000)) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Âge lisible d'une séance ancienne : « 13 h », « 3 jours ». */
export function formatActiveAge(startedAt: string, nowMs: number): string {
  const start = Date.parse(startedAt);
  const hours = Number.isFinite(start) ? Math.max(0, Math.floor((nowMs - start) / 3_600_000)) : 0;
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} jours`;
}

export async function loadActiveSession(
  storage: StoragePort,
): Promise<ActiveSessionSnapshot | null> {
  try {
    return parseActiveSession(await storage.get<unknown>(ACTIVE_SESSION_KEY));
  } catch {
    return null;
  }
}

export async function writeActiveSession(
  storage: StoragePort,
  snap: ActiveSessionSnapshot | null,
): Promise<void> {
  if (snap) await storage.set(ACTIVE_SESSION_KEY, snap);
  else await storage.remove(ACTIVE_SESSION_KEY);
}

/** Prévient le bandeau (même onglet) que la séance en cours a changé. */
export function announceActiveSession(summary: ActiveSessionSummary | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(STORAGE_KEYS.EVENT_ACTIVE_SESSION_CHANGED, { detail: summary }),
  );
}

export interface ActiveSessionWriter {
  /** Programme l'écriture (regroupée) ; null = effacement, écrit tout de suite. */
  schedule(snap: ActiveSessionSnapshot | null): void;
  /** Écrit immédiatement ce qui est en attente. */
  flush(): Promise<void>;
  /** Vrai si une écriture attend encore. */
  pending(): boolean;
}

/**
 * Écritures légères : plusieurs changements rapprochés (série + repos qui démarre)
 * donnent une seule écriture après `delayMs`. L'effacement n'attend pas.
 */
export function createActiveSessionWriter(
  write: (snap: ActiveSessionSnapshot | null) => Promise<void>,
  delayMs = 400,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (h: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): ActiveSessionWriter {
  let handle: unknown = null;
  let queued: { snap: ActiveSessionSnapshot | null } | null = null;
  let chain: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
    if (!queued) return chain;
    const { snap } = queued;
    queued = null;
    // Écritures en série : un effacement ne peut pas être doublé par une écriture plus ancienne.
    chain = chain
      .then(() => write(snap))
      .catch((err: unknown) => console.warn('[active-session] write failed:', err));
    return chain;
  };

  return {
    schedule(snap) {
      queued = { snap };
      if (snap === null) {
        void run();
        return;
      }
      if (handle === null) handle = timers.set(() => void run(), delayMs);
    },
    flush: run,
    pending: () => queued !== null,
  };
}
