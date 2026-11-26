import {
  openLegacyFallbackStorage,
  SystemClock,
  UuidGenerator,
  ToastNotifier,
  SyncedStorage,
  SupabaseSyncRemote,
  SupabaseDailyLogSync,
  NoopDailyLogSync,
  supabase,
  getLocalSessionUser,
} from '@kinetic/adapters-web';
import { STORAGE_KEYS } from '@kinetic/core';
import { createDepsManager, GUEST_OWNER } from './deps.factory';
import { afterFirstRender } from './lib/performance';

export type { AppDeps } from './deps.factory';

const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const hasRemoteSync =
  supabase !== null &&
  typeof supabaseUrl === 'string' &&
  supabaseUrl.length > 10 &&
  !supabaseUrl.includes('xxxxxxxxxxxxxxxxxxxx');

/** Compte de la session enregistrée sur l'appareil (lecture locale, aucun réseau). */
const sessionUserId = (): string | null => getLocalSessionUser()?.id ?? null;

/** Propriétaires passés en repli (localStorage : lecture synchrone, hors IndexedDB). */
const FALLBACK_MARKS_KEY = STORAGE_KEYS.SYNC_FALLBACK_OWNERS;
function readMarks(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FALLBACK_MARKS_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeMarks(owners: string[]): void {
  if (owners.length === 0) localStorage.removeItem(FALLBACK_MARKS_KEY);
  else localStorage.setItem(FALLBACK_MARKS_KEY, JSON.stringify(owners));
}
const fallbackMarks = {
  has: (owner: string) => readMarks().includes(owner),
  add: (owner: string) => writeMarks([...new Set([...readMarks(), owner])]),
  delete: (owner: string) => writeMarks(readMarks().filter((o) => o !== owner)),
};

const manager = createDepsManager({
  createLocalStorage: (owner) => openLegacyFallbackStorage({ owner }),
  fallbackMarks,
  createClock: () => new SystemClock(),
  createIdGen: () => new UuidGenerator(),
  createNotifier: () => new ToastNotifier(),
  createNoopDailyLogSync: () => new NoopDailyLogSync(),
  createDailyLogSync: () => new SupabaseDailyLogSync(supabase!),
  hasRemoteSync,
  getSessionUserId: sessionUserId,
  openStorage: (owner, { recoverFallbackWrites }) =>
    SyncedStorage.open({
      owner,
      recoverFallbackWrites,
      remote:
        owner === GUEST_OWNER || !supabase
          ? null
          : new SupabaseSyncRemote(supabase, owner, sessionUserId),
      loadMerge: () => import('./lib/sync-merge').then((m) => m.syncMerge),
    }),
  onStorageReady: (storage) => {
    // Synchro cloud après le premier écran : l'accueil s'affiche d'abord avec les
    // données locales, la synchro ne concurrence ni ses lectures ni son rendu.
    afterFirstRender(() => {
      storage.start?.();
      if (storage instanceof SyncedStorage && storage.syncEnabled) offerGuestData(storage);
    });
  },
});

/**
 * Liaison invité → compte (sync.md § 4.1) : après le premier pull complet du compte,
 * si la base invité de l'appareil contient des données jamais rattachées, l'utilisateur
 * est prévenu ; le choix (ajouter / ne pas ajouter) se fait dans le profil. Rien n'est
 * fusionné automatiquement.
 */
function offerGuestData(storage: SyncedStorage): void {
  const stop = storage.onStatus((status) => {
    if (status.lastPullAt === null) return;
    stop();
    void storage
      .guestDataSummary()
      .then(({ count, decision }) => {
        if (count === 0 || decision !== null) return;
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: {
              kind: 'info',
              message:
                'Des données enregistrées sur cet appareil en mode invité peuvent être ajoutées à ton compte (Profil › Compte).',
            },
          }),
        );
      })
      .catch(() => undefined);
  });
}

export const getDeps = () => manager.getDeps();
export const resetDeps = () => manager.resetDeps();
export const flushAndResetDeps = () => manager.flushAndResetDeps();
export const _resetDepsForTesting = (mock: import('./deps.factory').AppDeps) =>
  manager.setDepsForTesting(mock);

/** Stockage synchronisé courant (état de synchro, actions du profil) ; `null` sinon. */
export async function getSyncedStorage(): Promise<SyncedStorage | null> {
  const deps = await getDeps().catch(() => null);
  return deps?.storage instanceof SyncedStorage ? deps.storage : null;
}

/**
 * Avant une déconnexion : envoie tout de suite ce qui attend, puis renvoie le nombre
 * de modifications encore non enregistrées dans le cloud.
 */
export async function pendingAfterFlush(): Promise<number> {
  const storage = await getSyncedStorage();
  if (!storage || !storage.syncEnabled) return 0;
  try {
    await storage.flushPendingWrites({ ignoreBackoff: true });
  } catch (err) {
    console.warn('[deps] flush avant déconnexion :', err);
  }
  return storage.pendingCount();
}

/**
 * La session (compte) a changé : si la base ouverte n'est pas celle du compte de la
 * session, elle est fermée (après envoi de ce qui attend) et la bonne est ouverte.
 */
export async function rebuildDepsForSession(): Promise<boolean> {
  if (manager.currentOwner() === manager.desiredOwner()) return false;
  await manager.flushAndResetDeps();
  await getDeps();
  return true;
}

let authRebuildInflight: Promise<void> | null = null;
const win =
  typeof window !== 'undefined'
    ? (window as Window & { _kineticAuthChangedListening?: boolean })
    : null;

if (win && !win._kineticAuthChangedListening) {
  win._kineticAuthChangedListening = true;
  win.addEventListener(STORAGE_KEYS.EVENT_AUTH_CHANGED, async () => {
    if (authRebuildInflight) {
      await authRebuildInflight;
      return;
    }
    authRebuildInflight = (async () => {
      try {
        const rebuilt = await rebuildDepsForSession();
        if (rebuilt) win.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_DEPS_READY));
      } catch (err) {
        console.warn('[deps] rebuild after auth-changed failed:', err);
      }
    })();
    try {
      await authRebuildInflight;
    } finally {
      authRebuildInflight = null;
    }
  });
}
