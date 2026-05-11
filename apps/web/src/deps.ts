import {
  IdbStorage,
  SystemClock,
  UuidGenerator,
  ToastNotifier,
  HybridStorage,
  SupabaseStorage,
  SupabaseDailyLogSync,
  NoopDailyLogSync,
  supabase,
  getAuthUser,
} from '@kinetic/adapters-web';
import { createDepsManager } from './deps.factory';

export type { AppDeps } from './deps.factory';

const supabaseUrl = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const hasRemoteSync = supabase !== null
  && typeof supabaseUrl === 'string'
  && supabaseUrl.length > 10
  && !supabaseUrl.includes('xxxxxxxxxxxxxxxxxxxx');

const manager = createDepsManager({
  createLocalStorage: () => new IdbStorage(),
  createClock: () => new SystemClock(),
  createIdGen: () => new UuidGenerator(),
  createNotifier: () => new ToastNotifier(),
  createNoopDailyLogSync: () => new NoopDailyLogSync(),
  createRemoteStorage: (userId) => new SupabaseStorage(supabase!, userId),
  createHybridStorage: (local, remote) => new HybridStorage(local, remote),
  createDailyLogSync: () => new SupabaseDailyLogSync(supabase!),
  getAuthUser,
  hasRemoteSync,
  syncTimeoutMs: 8000,
  onHybridReady: (storage) => {
    void storage.syncFromRemote?.().catch((err) => {
      console.warn('[deps] remote sync failed:', err);
    });
  },
});

export const getDeps = () => manager.getDeps();
export const resetDeps = () => manager.resetDeps();
export const flushAndResetDeps = () => manager.flushAndResetDeps();
export const _resetDepsForTesting = (mock: import('./deps.factory').AppDeps) => manager.setDepsForTesting(mock);

let authRebuildInflight: Promise<void> | null = null;
const win = typeof window !== 'undefined'
  ? (window as Window & { _kineticAuthChangedListening?: boolean })
  : null;

if (win && !win._kineticAuthChangedListening) {
  win._kineticAuthChangedListening = true;
  win.addEventListener('kinetic:auth-changed', async () => {
    if (authRebuildInflight) {
      await authRebuildInflight;
      return;
    }
    const current = await getDeps().catch(() => null);
    if (current?.storage instanceof HybridStorage) return;
    if (authRebuildInflight) {
      await authRebuildInflight;
      return;
    }

    authRebuildInflight = (async () => {
      resetDeps();
      try {
        await getDeps();
      } catch (err) {
        console.warn('[deps] rebuild after auth-changed failed:', err);
        return;
      }
      win.dispatchEvent(new CustomEvent('kinetic:deps-ready'));
    })();

    try {
      await authRebuildInflight;
    } finally {
      authRebuildInflight = null;
    }
  });
}
