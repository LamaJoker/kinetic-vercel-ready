/**
 * Container de dépendances — résout les ports en implémentations concrètes.
 * FIX CRITIQUE : timeout 3s sur Supabase, fallback local garanti.
 * L'app ne bloque JAMAIS même si Supabase est inaccessible.
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function getDeps(): Promise<AppDeps> {
  if (_deps) return _deps;
  if (_inflight) return _inflight;

  _inflight = (async (): Promise<AppDeps> => {
    const local    = new IdbStorage();
    const clock    = new SystemClock();
    const idGen    = new UuidGenerator();
    const notifier = new ToastNotifier();

    let storage: StoragePort           = local;
    let dailyLogSync: DailyLogSyncPort = new NoopDailyLogSync();

    // Vérifier que l'URL Supabase n'est pas le placeholder par défaut
    const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
    const hasRealSupabase = supabase !== null
      && typeof supabaseUrl === 'string'
      && supabaseUrl.length > 10
      && !supabaseUrl.includes('xxxxxxxxxxxxxxxxxxxx');

    if (hasRealSupabase && supabase) {
      try {
        // Timeout 3s — si Supabase ne répond pas, on part en mode local
        const user = await withTimeout(getAuthUser(), 3000);
        if (user) {
          const remote = new SupabaseStorage(supabase, user.id);
          const hybrid = new HybridStorage(local, remote);
          void hybrid.syncFromRemote().catch((err) =>
            console.warn('[deps] remote sync failed:', err)
          );
          storage      = hybrid;
          dailyLogSync = new SupabaseDailyLogSync(supabase);
        }
      } catch (err) {
        console.warn('[deps] Supabase unreachable, using local storage:', err);
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
