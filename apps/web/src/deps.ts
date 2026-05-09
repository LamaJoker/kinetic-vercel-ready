/**
 * Container de dependances - resout les ports en implementations concretes.
 *
 * Garanties:
 * - Timeout 8s sur Supabase -> fallback local garanti.
 * - Un seul build Supabase en cours a la fois grace au pattern inflight.
 * - Protection contre les races post-resetDeps() via AbortController.
 * - Flush best-effort du HybridStorage avant reset/logout pour limiter la perte
 *   de writes en attente.
 */
import {
  IdbStorage, SystemClock, UuidGenerator, ToastNotifier,
  HybridStorage, SupabaseStorage, SupabaseDailyLogSync, NoopDailyLogSync,
  supabase, getAuthUser,
} from '@kinetic/adapters-web';
import type { StoragePort, ClockPort, IdGeneratorPort, NotifierPort, DailyLogSyncPort } from '@kinetic/core';

export interface AppDeps {
  storage: StoragePort;
  clock: ClockPort;
  idGen: IdGeneratorPort;
  notifier: NotifierPort;
  dailyLogSync: DailyLogSyncPort;
}

let _deps: AppDeps | null = null;
let _inflight: Promise<AppDeps> | null = null;
let _abortCtrl: AbortController | null = null;
let _authRebuildInflight: Promise<void> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function getDeps(): Promise<AppDeps> {
  if (_deps) return _deps;
  if (_inflight) return _inflight;

  const ctrl = new AbortController();
  _abortCtrl = ctrl;

  _inflight = (async (): Promise<AppDeps> => {
    const local = new IdbStorage();
    const clock = new SystemClock();
    const idGen = new UuidGenerator();
    const notifier = new ToastNotifier();

    let storage: StoragePort = local;
    let dailyLogSync: DailyLogSyncPort = new NoopDailyLogSync();

    const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
    const hasRealSupabase = supabase !== null
      && typeof supabaseUrl === 'string'
      && supabaseUrl.length > 10
      && !supabaseUrl.includes('xxxxxxxxxxxxxxxxxxxx');

    if (hasRealSupabase && supabase) {
      try {
        const user = await withTimeout(getAuthUser(), 8000);

        if (ctrl.signal.aborted) {
          return { storage: local, clock, idGen, notifier, dailyLogSync };
        }

        if (user) {
          const remote = new SupabaseStorage(supabase, user.id);
          const hybrid = new HybridStorage(local, remote);
          void hybrid.syncFromRemote().catch((err) =>
            console.warn('[deps] remote sync failed:', err)
          );
          storage = hybrid;
          dailyLogSync = new SupabaseDailyLogSync(supabase);
        }
      } catch (err) {
        console.warn('[deps] Supabase unreachable, using local storage:', err);
      }
    }

    const result: AppDeps = { storage, clock, idGen, notifier, dailyLogSync };
    if (!ctrl.signal.aborted) {
      _deps = result;
    }
    return result;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

export function resetDeps(): void {
  _abortCtrl?.abort();
  _abortCtrl = null;
  _deps = null;
}

export async function flushAndResetDeps(): Promise<void> {
  const currentStorage = _deps?.storage;
  if (currentStorage instanceof HybridStorage) {
    try {
      await currentStorage.flushPendingWrites();
    } catch (err) {
      console.warn('[deps] flush before reset failed:', err);
    }
  }
  resetDeps();
}

export function _resetDepsForTesting(mock: AppDeps): void {
  _deps = mock;
}

const _WIN = typeof window !== 'undefined'
  ? (window as Window & { _kineticAuthChangedListening?: boolean })
  : null;

if (_WIN && !_WIN._kineticAuthChangedListening) {
  _WIN._kineticAuthChangedListening = true;
  _WIN.addEventListener('kinetic:auth-changed', async () => {
    if (_deps?.storage instanceof HybridStorage) return;
    if (_authRebuildInflight) {
      await _authRebuildInflight;
      return;
    }

    console.info('[deps] auth-changed received after timeout - rebuilding with HybridStorage');
    _authRebuildInflight = (async () => {
      resetDeps();
      try {
        await getDeps();
      } catch (err) {
        console.warn('[deps] rebuild after auth-changed failed:', err);
        return;
      }
      _WIN.dispatchEvent(new CustomEvent('kinetic:deps-ready'));
    })();

    try {
      await _authRebuildInflight;
    } finally {
      _authRebuildInflight = null;
    }
  });
}
