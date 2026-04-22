// ─── Adapters de base (local-first) ─────────────────────────
export { IdbStorage }      from './IdbStorage.js';
export { SystemClock }     from './SystemClock.js';
export { UuidGenerator }   from './UuidGenerator.js';
export { ToastNotifier }   from './ToastNotifier.js';

// ─── Couche Supabase (optionnelle) ──────────────────────────
export { HybridStorage }    from './supabase/HybridStorage.js';
export { SupabaseStorage }  from './supabase/SupabaseStorage.js';
export { SupabaseDailyLogSync, NoopDailyLogSync } from './supabase/SupabaseDailyLogSync.js';
export { AuthRateLimiter, authRateLimiter } from './supabase/RateLimiter.js';
export {
  supabase,
  getAuthUser,
  signInWithEmail,
  signInWithGitHub,
  signInWithGoogle,
  signOut,
} from './supabase/auth.js';
export type { AuthUser }    from './supabase/auth.js';
export type { Database, Json } from './supabase/database.types.js';
