import type { SupabaseClient } from '@supabase/supabase-js';
import type { StoragePort, StorageKey } from '@kinetic/core';
import type { Database, Json } from './database.types.js';
import type { PullCapableStorage, RemoteChange } from './HybridStorage.js';

/** Code PostgREST « fonction introuvable » (migration 009 non appliquée). */
const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';

export class SupabaseStorage implements StoragePort, PullCapableStorage {
  constructor(
    private readonly client: SupabaseClient<Database>,
    private readonly userId: string,
  ) {}

  /**
   * Renvoie `null` si la clé n'existe pas. Une erreur réseau/RLS est LEVÉE :
   * la confondre avec « absent » ferait croire au sync que la donnée n'existe pas.
   */
  async get<T>(key: StorageKey): Promise<T | null> {
    const { data, error } = await this.client
      .from('user_storage')
      .select('value')
      .eq('user_id', this.userId)
      .eq('key', key)
      .maybeSingle();

    if (error) throw new Error(`[SupabaseStorage] get "${key}" failed: ${error.message}`);
    if (!data) return null;
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
   * pullChanges — delta sync en UNE requête paginée (clés + valeurs + updated_at
   * serveur) via la RPC `sync_pull` (migration 009). Renvoie `null` si la RPC
   * n'existe pas encore → HybridStorage utilise le mode legacy.
   */
  async pullChanges(
    since: string,
    afterKey: string,
    limit: number,
  ): Promise<RemoteChange[] | null> {
    const { data, error } = await this.client.rpc('sync_pull', {
      p_since: since,
      p_after_key: afterKey,
      p_limit: limit,
    });

    if (error) {
      if (error.code === PGRST_FUNCTION_NOT_FOUND) return null;
      throw new Error(`[SupabaseStorage] sync_pull failed: ${error.message}`);
    }

    return (data ?? []).map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * keysSince — mode legacy : clés modifiées après `since` (ISO).
   * Conservé pour les bases où la migration 009 n'est pas appliquée.
   */
  async keysSince(since: string): Promise<readonly StorageKey[]> {
    return this._paginateKeys(since);
  }

  /** Pagine par 1 000 pour contourner le plafond de lignes PostgREST. */
  private async _paginateKeys(since: string | null): Promise<readonly StorageKey[]> {
    const PAGE = 1000;
    const keys: StorageKey[] = [];
    let offset = 0;

    for (;;) {
      let q = this.client
        .from('user_storage')
        .select('key')
        .eq('user_id', this.userId)
        .order('key', { ascending: true })
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
