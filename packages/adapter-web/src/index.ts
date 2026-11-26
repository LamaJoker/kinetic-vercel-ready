// ─── Adapters de base (local-first) ─────────────────────────
export { IdbStorage } from './IdbStorage.js';
export { SystemClock } from './SystemClock.js';
export { UuidGenerator } from './UuidGenerator.js';
export { ToastNotifier } from './ToastNotifier.js';
export { validateStorageKey, validateStorageValue } from './validation.js';

// ─── Synchro : base IndexedDB par compte + outbox (sync.md § 4) ─
export { SyncedStorage, backoffDelayMs } from './sync/SyncedStorage.js';
// Repli sur l'ancienne base : chargé à la demande (lot séparé), jamais au démarrage.
export { openLegacyFallbackStorage } from './sync/fallback-loader.js';
export type {
  SyncedStorageOptions,
  MergeModule,
  RecoveryItem,
  GuestDataSummary,
} from './sync/SyncedStorage.js';
export { LocalSyncDb, OwnerMismatchError, GUEST_OWNER, dbNameForOwner } from './sync/local-db.js';
export { isLocalOnlyKey, LOCAL_ONLY_KEYS } from './sync/local-keys.js';
// Parade WebKit : IndexedDB qui ne répond plus (sync.md § 4.11).
export {
  IdbUnresponsiveError,
  isIdbUnresponsive,
  onIdbUnresponsive,
  DEFAULT_IDB_GUARD,
} from './sync/idb.js';
export type { IdbGuardOptions, IdbTimers } from './sync/idb.js';
export { SyncCallError } from './sync/remote.js';
export type {
  SyncRemote,
  PushItem,
  PushResult,
  PullPage,
  PullChange,
  RemoteKeyState,
} from './sync/remote.js';

// ─── Couche Supabase (optionnelle) ──────────────────────────
export { HybridStorage } from './supabase/HybridStorage.js';
export { SupabaseStorage } from './supabase/SupabaseStorage.js';
export { SupabaseSyncRemote, classifyCallError } from './supabase/SupabaseSyncRemote.js';
export { SupabaseDailyLogSync, NoopDailyLogSync } from './supabase/SupabaseDailyLogSync.js';
export { AuthRateLimiter, authRateLimiter } from './supabase/RateLimiter.js';
export {
  supabase,
  getAuthUser,
  getLocalSessionUser,
  AUTH_STORAGE_KEY,
  signInWithEmail,
  signInWithGitHub,
  signInWithGoogle,
  signOut,
  callbackUrl,
} from './supabase/auth.js';
export type { AuthUser } from './supabase/auth.js';
export type { Database, Json } from './supabase/database.types.js';
