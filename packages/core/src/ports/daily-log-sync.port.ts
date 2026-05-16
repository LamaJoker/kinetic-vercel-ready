/**
 * DailyLogSyncPort — remonte l'activité du jour vers un backend.
 *
 * Le domaine ne sait pas si c'est Supabase RPC, REST, ou rien du tout.
 * Implémentations :
 *   - NoopDailyLogSync   → mode local (écrit nulle part)
 *   - SupabaseDailyLogSync → appelle upsert_daily_log() via Supabase RPC
 */
export interface DailyLogEntry {
  date: string; // ISO "YYYY-MM-DD"
  xpEarned: number;
  tasksDone: number;
  streakDay: number;
  metadata?: Record<string, unknown>;
}

export interface DailyLogSyncPort {
  upsert(entry: DailyLogEntry): Promise<void>;
}
