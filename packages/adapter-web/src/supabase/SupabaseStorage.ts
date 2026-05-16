import type { SupabaseClient } from '@supabase/supabase-js';
import type { StoragePort, StorageKey } from '@kinetic/core';
import type { Database, Json } from './database.types.js';

export class SupabaseStorage implements StoragePort {
  constructor(
    private readonly client: SupabaseClient<Database>,
    private readonly userId: string,
  ) {}

  async get<T>(key: StorageKey): Promise<T | null> {
    const { data, error } = await this.client
      .from('user_storage')
      .select('value')
      .eq('user_id', this.userId)
      .eq('key', key)
      .single();

    if (error || !data) return null;
    return data.value as T;
  }

  async set<T>(key: StorageKey, value: T): Promise<void> {
    const { error } = await this.client.from('user_storage').upsert(
      {
        user_id: this.userId,
        key,
        value: value as Json,
      },
      { onConflict: 'user_id,key' },
    );

    if (error) {
      console.error('[SupabaseStorage] set failed:', error.message);
      throw new Error(error.message);
    }
  }

  async remove(key: StorageKey): Promise<void> {
    const { error } = await this.client
      .from('user_storage')
      .delete()
      .eq('user_id', this.userId)
      .eq('key', key);

    if (error) {
      console.error('[SupabaseStorage] remove failed:', error.message);
      throw new Error(error.message);
    }
  }

  async keys(): Promise<readonly StorageKey[]> {
    return this._paginateKeys(null);
  }

  /**
   * keysSince — delta sync: returns only keys modified after `since` (ISO timestamp).
   * Uses the updated_at column set by Supabase triggers on upsert.
   *
   * Called by HybridStorage.syncFromRemote() to avoid fetching every key on each
   * sync (N+1 problem). Falls back to full keys() scan on first sync (no lastSyncAt).
   */
  async keysSince(since: string): Promise<readonly StorageKey[]> {
    return this._paginateKeys(since);
  }

  /**
   * _paginateKeys — fetches all keys in pages of 1 000 to bypass the PostgREST
   * default row cap. Pass `since` for a delta query, null for a full scan.
   */
  private async _paginateKeys(since: string | null): Promise<readonly StorageKey[]> {
    const PAGE = 1000;
    const keys: StorageKey[] = [];
    let offset = 0;

    for (;;) {
      let q = this.client
        .from('user_storage')
        .select('key')
        .eq('user_id', this.userId)
        .range(offset, offset + PAGE - 1);

      if (since !== null) {
        q = q.gte('updated_at', since);
      }

      const { data, error } = await q;

      if (error) {
        console.error('[SupabaseStorage] keys fetch failed:', error.message);
        throw new Error(error.message);
      }

      const page = (data ?? []) as Array<{ key: StorageKey }>;
      for (const row of page) keys.push(row.key);
      if (page.length < PAGE) break;
      offset += PAGE;
    }

    return keys;
  }

  async clear(): Promise<void> {
    const { error } = await this.client.from('user_storage').delete().eq('user_id', this.userId);

    if (error) {
      console.error('[SupabaseStorage] clear failed:', error.message);
      throw new Error(error.message);
    }
  }
}
