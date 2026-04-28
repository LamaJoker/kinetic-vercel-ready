import type { SupabaseClient } from '@supabase/supabase-js';
import type { DailyLogSyncPort, DailyLogEntry } from '@kinetic/core';
import type { Database, Json } from './database.types.js';

function toJson(value: unknown): Json | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => toJson(item))
      .filter((item): item is Json => item !== undefined);
  }

  if (typeof value === 'object') {
    const record: { [key: string]: Json | undefined } = {};

    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = toJson(entry);
      if (normalizedEntry !== undefined) {
        record[key] = normalizedEntry;
      }
    }

    return record;
  }

  return undefined;
}

/**
 * SupabaseDailyLogSync - calls the Postgres RPC `upsert_daily_log`.
 *
 * The SQL function validates bounds and resolves conflicts by user_id+date.
 * Network failures are thrown to the caller (fire-and-forget is allowed upstream).
 */
export class SupabaseDailyLogSync implements DailyLogSyncPort {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async upsert(entry: DailyLogEntry): Promise<void> {
    const metadata = entry.metadata ? toJson(entry.metadata) : null;

    const { error } = await this.client.rpc('upsert_daily_log', {
      p_date: entry.date,
      p_xp_earned: entry.xpEarned,
      p_tasks_done: entry.tasksDone,
      p_streak_day: entry.streakDay,
      p_metadata: metadata ?? null,
    });
    if (error) throw new Error(`[SupabaseDailyLogSync] ${error.message}`);
  }
}

/**
 * NoopDailyLogSync - guest / offline-only mode.
 */
export class NoopDailyLogSync implements DailyLogSyncPort {
  async upsert(_entry: DailyLogEntry): Promise<void> {
    // intentionally empty
  }
}

