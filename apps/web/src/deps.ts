/**
 * Container de dépendances — résout les ports en implémentations concrètes.
 * FIX: dailyLogSync correctement typé dans AppDeps
 */
import {
  IdbStorage, SystemClock, UuidGenerator, ToastNotifier,
  HybridStorage, SupabaseStorage, SupabaseDailyLogSync, NoopDailyLogSync,
  supabase, getAuthUser,
} from '@kinetic/adapters-web';
import type { StoragePort, ClockPort, IdGeneratorPort, NotifierPort, DailyLogSyncPort } from '@kinetic/core';

export interface AppDeps {
  storage:       StoragePort;
  clock:         ClockPort;
  idGen:         IdGeneratorPort;
  notifier:      NotifierPort;
  dailyLogSync:  DailyLogSyncPort;
}

let _deps: AppDeps | null = null;
let _inflight: Promise<AppDeps> | null = null;

export async function getDeps(): Promise<AppDeps> {
  if (_deps)     return _deps;
  if (_inflight) return _inflight;

  _inflight = (async (): Promise<AppDeps> => {
    const local    = new IdbStorage();
    const clock    = new SystemClock();
    const idGen    = new UuidGenerator();
    const notifier = new ToastNotifier();

    let storage: StoragePort           = local;
    let dailyLogSync: DailyLogSyncPort = new NoopDailyLogSync();

    if (supabase) {
      try {
        const user = await getAuthUser();
        if (user) {
          const remote = new SupabaseStorage(supabase, user.id);
          const hybrid = new HybridStorage(local, remote);
          void hybrid.syncFromRemote().catch((err) => console.warn('[deps] sync failed:', err));
          storage      = hybrid;
          dailyLogSync = new SupabaseDailyLogSync(supabase);
        }
      } catch (err) {
        console.warn('[deps] Supabase user fetch failed, falling back to local:', err);
      }
    }

    _deps = { storage, clock, idGen, notifier, dailyLogSync };
    return _deps;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

export function resetDeps(): void {
  _deps = null;
}

export function _resetDepsForTesting(mock: AppDeps): void {
  _deps = mock;
}
