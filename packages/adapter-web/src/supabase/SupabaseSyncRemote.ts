import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './database.types.js';
import {
  SyncCallError,
  type PullChange,
  type PullPage,
  type PushItem,
  type PushResult,
  type RemoteKeyState,
  type SyncRemote,
} from '../sync/remote.js';

/** PostgREST : fonction introuvable (serveur pas encore migré en 010). */
const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';
const EPOCH = '1970-01-01T00:00:00.000Z';

interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

function isAuthError(error: PgError, status: number): boolean {
  const code = error.code ?? '';
  return (
    code === '42501' ||
    code.startsWith('PGRST30') ||
    status === 401 ||
    status === 403 ||
    /jwt/i.test(error.message ?? '')
  );
}

function isNetworkError(error: PgError, status: number): boolean {
  return (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    /fetch|network|timeout|abort/i.test(error.message ?? '')
  );
}

/** Erreur d'un appel entier → SyncCallError typée (réseau / auth / fatale). */
export function classifyCallError(error: PgError, status: number, what: string): SyncCallError {
  const msg = `[sync] ${what} : ${error.message ?? 'erreur inconnue'}`;
  if (isAuthError(error, status)) return new SyncCallError('auth', msg, error.code ?? null);
  if (isNetworkError(error, status)) return new SyncCallError('network', msg, error.code ?? null);
  return new SyncCallError('fatal', msg, error.code ?? null);
}

/** Raison de rejet d'un élément sur l'ancien chemin (upsert direct). */
function legacyItemReason(error: PgError): string {
  const code = error.code ?? '';
  if (code === 'P0001') return 'quota_keys';
  if (code === 'P0002' || /quota/i.test(error.message ?? '')) return 'quota_bytes';
  if (code === '54000' || code === '23514') return 'value_too_large';
  return `internal:${code || 'unknown'}`;
}

/**
 * SyncRemote sur Supabase : RPC `sync_push` / `sync_pull_v2` / `sync_delete_all`
 * (migration 010). Si le serveur n'est pas encore migré (`PGRST202`), repli sur
 * l'ancien chemin (upsert / delete / `sync_pull`) sans écriture conditionnelle
 * (« dernière écriture gagne »), signalé en journal (sync.md § 5).
 */
export class SupabaseSyncRemote implements SyncRemote {
  private legacyPush = false;
  private legacyPull = false;

  /**
   * @param currentUserId compte de la session ACTIVE du client (lecture locale). Le client
   *   Supabase est partagé : si sa session appartient à un autre compte (changement de
   *   compte), tout appel est refusé avant d'atteindre le serveur — sinon les écritures
   *   de ce compte partiraient, par la RLS, dans le compte de la session (F2).
   */
  constructor(
    private readonly client: SupabaseClient<Database>,
    readonly userId: string,
    private readonly currentUserId: (() => string | null) | null = null,
  ) {}

  private assertSession(): void {
    if (!this.currentUserId) return;
    const active = this.currentUserId();
    if (active !== this.userId) {
      throw new SyncCallError(
        'auth',
        `[sync] session active (${active ?? 'aucune'}) ≠ compte de la base (${this.userId})`,
        'session_mismatch',
      );
    }
  }

  /** Mode de repli actif (serveur sans migration 010). */
  get legacyMode(): boolean {
    return this.legacyPush || this.legacyPull;
  }

  async push(items: readonly PushItem[]): Promise<PushResult[]> {
    this.assertSession();
    if (!this.legacyPush) {
      const { data, error, status } = await this.client.rpc('sync_push', {
        p_items: items as unknown as Json,
      });
      if (!error) return data as unknown as PushResult[];
      if (error.code !== PGRST_FUNCTION_NOT_FOUND)
        throw classifyCallError(error, status, 'sync_push');
      console.warn('[sync] sync_push absente (migration 010 non appliquée) : mode compatibilité');
      this.legacyPush = true;
    }
    const out: PushResult[] = [];
    for (const item of items) out.push(await this.legacyPushItem(item));
    return out;
  }

  private async legacyPushItem(item: PushItem): Promise<PushResult> {
    if (item.deleted) {
      const { error, status } = await this.client
        .from('user_storage')
        .delete()
        .eq('user_id', this.userId)
        .eq('key', item.key);
      if (error) {
        if (isAuthError(error, status) || isNetworkError(error, status)) {
          throw classifyCallError(error, status, 'delete');
        }
        return {
          key: item.key,
          status: 'rejected',
          reason: legacyItemReason(error),
          updated_at: null,
        };
      }
      return { key: item.key, status: 'ok', updated_at: null, deleted: true };
    }
    const { data, error, status } = await this.client
      .from('user_storage')
      .upsert(
        { user_id: this.userId, key: item.key, value: (item.value ?? null) as Json },
        { onConflict: 'user_id,key' },
      )
      .select('updated_at')
      .maybeSingle();
    if (error) {
      if (isAuthError(error, status) || isNetworkError(error, status)) {
        throw classifyCallError(error, status, 'upsert');
      }
      return {
        key: item.key,
        status: 'rejected',
        reason: legacyItemReason(error),
        updated_at: null,
      };
    }
    // Sans 010, la version (`updated_at`) peut être fixée par le client : on ne la retient pas.
    void data;
    return { key: item.key, status: 'ok', updated_at: null, deleted: false };
  }

  async pull(since: string | null, afterKey: string, limit: number): Promise<PullPage> {
    this.assertSession();
    if (!this.legacyPull) {
      const { data, error, status } = await this.client.rpc('sync_pull_v2', {
        p_since: since,
        p_after_key: afterKey,
        p_limit: limit,
      });
      if (!error) return data as unknown as PullPage;
      if (error.code !== PGRST_FUNCTION_NOT_FOUND) {
        throw classifyCallError(error, status, 'sync_pull_v2');
      }
      console.warn(
        '[sync] sync_pull_v2 absente (migration 010 non appliquée) : mode compatibilité',
      );
      this.legacyPull = true;
    }
    const { data, error, status } = await this.client.rpc('sync_pull', {
      p_since: since ?? EPOCH,
      p_after_key: afterKey,
      p_limit: limit,
    });
    if (error) throw classifyCallError(error, status, 'sync_pull');
    const rows = (data ?? []) as Array<{ key: string; value: unknown; updated_at: string }>;
    const changes: PullChange[] = rows.map((r) => ({
      key: r.key,
      value: r.value,
      deleted: false,
      updated_at: r.updated_at,
    }));
    return { changes, has_more: rows.length >= limit, resync_required: false };
  }

  async deleteAll(): Promise<{ deleted_count: number; updated_at: string | null }> {
    this.assertSession();
    if (!this.legacyPush) {
      const { data, error, status } = await this.client.rpc('sync_delete_all');
      if (!error) return data as unknown as { deleted_count: number; updated_at: string | null };
      if (error.code !== PGRST_FUNCTION_NOT_FOUND) {
        throw classifyCallError(error, status, 'sync_delete_all');
      }
      this.legacyPush = true;
    }
    const { error, status } = await this.client
      .from('user_storage')
      .delete()
      .eq('user_id', this.userId);
    if (error) throw classifyCallError(error, status, 'delete all');
    return { deleted_count: -1, updated_at: null };
  }

  async fetchKey(key: string): Promise<RemoteKeyState | null> {
    this.assertSession();
    const { data, error, status } = await this.client
      .from('user_storage')
      .select('value, deleted, updated_at')
      .eq('user_id', this.userId)
      .eq('key', key)
      .maybeSingle();
    if (error) throw classifyCallError(error, status, 'lecture de clé');
    if (!data) return null;
    const row = data as { value: unknown; deleted?: boolean; updated_at: string };
    return { value: row.value, deleted: row.deleted === true, updated_at: row.updated_at };
  }

  async refreshSession(): Promise<boolean> {
    if (this.currentUserId && this.currentUserId() !== this.userId) return false;
    try {
      const { data, error } = await this.client.auth.refreshSession();
      return !error && data.session?.user.id === this.userId;
    } catch {
      return false;
    }
  }
}
