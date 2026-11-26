import type {
  DailyLogSyncPort,
  IdGeneratorPort,
  NotifierPort,
  StoragePort,
  ClockPort,
} from '@kinetic/core';

export interface AppDeps {
  storage: StoragePort;
  clock: ClockPort;
  idGen: IdGeneratorPort;
  notifier: NotifierPort;
  dailyLogSync: DailyLogSyncPort;
  /** Propriétaire de la base locale : identifiant du compte ou `'guest'`. */
  owner?: string;
}

/** Stockage de l'app avec, s'il synchronise, son cycle de vie (SyncedStorage). */
export interface FlushableStorage extends StoragePort {
  start?(): void;
  flushPendingWrites?(opts?: { ignoreBackoff?: boolean }): Promise<void>;
  syncFromRemote?(opts?: { force?: boolean }): Promise<void>;
  pendingCount?(): Promise<number>;
  dispose?(): void;
  /** Écritures d'un repli précédent reprises à l'ouverture (ou rien à reprendre). */
  fallbackRecovered?: boolean;
}

/**
 * Mémo SYNCHRONE (hors IndexedDB : la base du compte est justement indisponible) des
 * propriétaires dont l'app a tourné en repli : à la prochaine ouverture réussie de leur
 * base, les écritures faites pendant le repli sont reprises.
 */
export interface FallbackMarks {
  add(owner: string): void;
  has(owner: string): boolean;
  delete(owner: string): void;
}

export const GUEST_OWNER = 'guest';

export interface DepsFactoryOptions {
  /**
   * Repli : ancienne base locale, si la base du compte ne peut pas être ouverte. Les
   * écritures y sont journalisées pour être reprises par la base du compte (`owner`).
   */
  createLocalStorage: (owner: string) => StoragePort | Promise<StoragePort>;
  /** Propriétaires passés en repli (voir `FallbackMarks`). */
  fallbackMarks?: FallbackMarks;
  createClock: () => ClockPort;
  createIdGen: () => IdGeneratorPort;
  createNotifier: () => NotifierPort;
  createNoopDailyLogSync: () => DailyLogSyncPort;
  createDailyLogSync: () => DailyLogSyncPort;
  /** Cloud configuré (client Supabase valide). */
  hasRemoteSync: boolean;
  /**
   * Compte de la session enregistrée SUR L'APPAREIL (lecture locale, sans réseau,
   * session expirée comprise) ; `null` = pas de session (mode invité).
   */
  getSessionUserId: () => string | null;
  /**
   * Ouvre la base locale du propriétaire (`userId` ou `'guest'`) ; `recoverFallbackWrites`
   * demande la reprise des écritures d'un repli précédent.
   */
  openStorage: (
    owner: string,
    opts: { recoverFallbackWrites: boolean },
  ) => Promise<FlushableStorage>;
  /**
   * IndexedDB ne répond plus (`IdbUnresponsiveError`, parade WebKit) : AUCUN repli (il
   * montrerait une base vide ou bloquerait de même), l'app recharge ou prévient.
   */
  onStorageUnresponsive?: (err: Error) => void;
  /** Base ouverte et adoptée : démarrage de la synchro (après le premier rendu). */
  onStorageReady?: (storage: FlushableStorage, owner: string) => void;
}

export interface DepsManager {
  getDeps(): Promise<AppDeps>;
  /** Propriétaire voulu d'après la session locale (compte ou `'guest'`). */
  desiredOwner(): string;
  /** Propriétaire de la base actuellement utilisée (`null` si pas encore ouverte). */
  currentOwner(): string | null;
  resetDeps(): void;
  flushAndResetDeps(): Promise<void>;
  setDepsForTesting(mock: AppDeps): void;
}

/**
 * Dépendances de l'app. Le stockage est choisi SANS appel réseau (sync.md § 4.5) :
 * session locale présente → base du compte + synchro (même hors-ligne) ; sinon base
 * invité. Un changement de compte change de base : aucune donnée d'un compte n'est
 * visible ni poussée dans un autre.
 */
export function createDepsManager(options: DepsFactoryOptions): DepsManager {
  let deps: AppDeps | null = null;
  let inflight: Promise<AppDeps> | null = null;
  let abortCtrl: AbortController | null = null;

  const desiredOwner = (): string => {
    if (!options.hasRemoteSync) return GUEST_OWNER;
    try {
      return options.getSessionUserId() ?? GUEST_OWNER;
    } catch (err) {
      console.warn('[deps] lecture de la session locale impossible :', err);
      return GUEST_OWNER;
    }
  };

  const disposeStorage = (storage: StoragePort | undefined): void => {
    (storage as FlushableStorage | undefined)?.dispose?.();
  };

  return {
    desiredOwner,

    currentOwner(): string | null {
      return deps?.owner ?? null;
    },

    async getDeps(): Promise<AppDeps> {
      if (deps) return deps;
      if (inflight) return inflight;

      const ctrl = new AbortController();
      abortCtrl = ctrl;

      inflight = (async (): Promise<AppDeps> => {
        const clock = options.createClock();
        const idGen = options.createIdGen();
        const notifier = options.createNotifier();
        const owner = desiredOwner();

        let storage: StoragePort;
        let synced: FlushableStorage | null = null;
        const marks = options.fallbackMarks;
        const recover = safeHas(marks, owner);
        try {
          synced = await options.openStorage(owner, { recoverFallbackWrites: recover });
          storage = synced;
          if (recover && synced.fallbackRecovered === true) safeCall(() => marks?.delete(owner));
        } catch (err) {
          if (isStorageUnresponsive(err)) {
            // IndexedDB bloqué (WebKit) : les données sont là mais illisibles. Le repli
            // (ancienne base, même IndexedDB) montrerait une base vide — ses seules
            // écritures de repli une fois la migration faite — ou bloquerait aussi. Pas de
            // repli, pas de mémo : l'erreur remonte et l'app recharge ou prévient.
            console.warn("[deps] stockage de l'appareil sans réponse :", err);
            safeCall(() => options.onStorageUnresponsive?.(err));
            throw err;
          }
          // Base du compte inutilisable (propriétaire différent, IndexedDB en panne,
          // migration échouée) : ancienne base locale, réessai au prochain lancement. Le
          // repli est mémorisé AVANT toute écriture : elles seront reprises par la base.
          console.warn('[deps] base locale du compte indisponible, repli :', err);
          safeCall(() => marks?.add(owner));
          storage = await options.createLocalStorage(owner);
        }

        const dailyLogSync =
          synced && owner !== GUEST_OWNER && options.hasRemoteSync
            ? options.createDailyLogSync()
            : options.createNoopDailyLogSync();
        const result: AppDeps = { storage, clock, idGen, notifier, dailyLogSync, owner };

        if (ctrl.signal.aborted) {
          // Reconstruction demandée pendant l'ouverture : base libérée, rien n'est mis en cache.
          disposeStorage(synced ?? undefined);
          return result;
        }
        deps = result;
        if (synced) options.onStorageReady?.(synced, owner);
        return result;
      })();

      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },

    resetDeps(): void {
      abortCtrl?.abort();
      abortCtrl = null;
      const previous = deps;
      deps = null;
      disposeStorage(previous?.storage);
    },

    async flushAndResetDeps(): Promise<void> {
      const currentStorage = deps?.storage as FlushableStorage | undefined;
      if (currentStorage?.flushPendingWrites) {
        try {
          await currentStorage.flushPendingWrites({ ignoreBackoff: true });
        } catch (err) {
          console.warn('[deps] flush before reset failed:', err);
        }
      }
      this.resetDeps();
    },

    setDepsForTesting(mock: AppDeps): void {
      deps = mock;
    },
  };
}

/** `IdbUnresponsiveError` (reconnue par son nom : ce module ne dépend pas des adaptateurs). */
export function isStorageUnresponsive(err: unknown): err is Error {
  return err instanceof Error && err.name === 'IdbUnresponsiveError';
}

function safeHas(marks: FallbackMarks | undefined, owner: string): boolean {
  try {
    return marks?.has(owner) ?? false;
  } catch {
    return false;
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn('[deps] mémo du repli indisponible :', err);
  }
}
