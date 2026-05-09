import type { DailyLogSyncPort, IdGeneratorPort, NotifierPort, StoragePort, ClockPort } from '@kinetic/core';

export interface AppDeps {
  storage: StoragePort;
  clock: ClockPort;
  idGen: IdGeneratorPort;
  notifier: NotifierPort;
  dailyLogSync: DailyLogSyncPort;
}

export interface AuthLikeUser {
  id: string;
}

export interface FlushableStorage extends StoragePort {
  flushPendingWrites?(): Promise<void>;
  syncFromRemote?(): Promise<void>;
}

export interface DepsFactoryOptions {
  createLocalStorage: () => StoragePort;
  createClock: () => ClockPort;
  createIdGen: () => IdGeneratorPort;
  createNotifier: () => NotifierPort;
  createNoopDailyLogSync: () => DailyLogSyncPort;
  createRemoteStorage: (userId: string) => StoragePort;
  createHybridStorage: (local: StoragePort, remote: StoragePort) => FlushableStorage;
  createDailyLogSync: () => DailyLogSyncPort;
  getAuthUser: () => Promise<AuthLikeUser | null>;
  hasRemoteSync: boolean;
  syncTimeoutMs: number;
  onHybridReady?: (storage: FlushableStorage) => void;
}

export interface DepsManager {
  getDeps(): Promise<AppDeps>;
  resetDeps(): void;
  flushAndResetDeps(): Promise<void>;
  setDepsForTesting(mock: AppDeps): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export function createDepsManager(options: DepsFactoryOptions): DepsManager {
  let deps: AppDeps | null = null;
  let inflight: Promise<AppDeps> | null = null;
  let abortCtrl: AbortController | null = null;

  return {
    async getDeps(): Promise<AppDeps> {
      if (deps) return deps;
      if (inflight) return inflight;

      const ctrl = new AbortController();
      abortCtrl = ctrl;

      inflight = (async (): Promise<AppDeps> => {
        const local = options.createLocalStorage();
        const clock = options.createClock();
        const idGen = options.createIdGen();
        const notifier = options.createNotifier();

        let storage: StoragePort = local;
        let dailyLogSync: DailyLogSyncPort = options.createNoopDailyLogSync();

        if (options.hasRemoteSync) {
          try {
            const user = await withTimeout(options.getAuthUser(), options.syncTimeoutMs);
            if (ctrl.signal.aborted) {
              return { storage: local, clock, idGen, notifier, dailyLogSync };
            }

            if (user) {
              const remote = options.createRemoteStorage(user.id);
              const hybrid = options.createHybridStorage(local, remote);
              options.onHybridReady?.(hybrid);
              storage = hybrid;
              dailyLogSync = options.createDailyLogSync();
            }
          } catch (err) {
            console.warn('[deps] remote bootstrap failed, using local storage:', err);
          }
        }

        const result: AppDeps = { storage, clock, idGen, notifier, dailyLogSync };
        if (!ctrl.signal.aborted) {
          deps = result;
        }
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
      deps = null;
    },

    async flushAndResetDeps(): Promise<void> {
      const currentStorage = deps?.storage as FlushableStorage | undefined;
      if (currentStorage?.flushPendingWrites) {
        try {
          await currentStorage.flushPendingWrites();
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
