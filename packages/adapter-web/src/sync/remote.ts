/**
 * Interface du serveur de synchro vue par le client (RPC de la migration 010,
 * docs/architecture/sync.md § 3). Implémentée par SupabaseSyncRemote.
 */

export interface PushItem {
  key: string;
  value?: unknown;
  deleted?: boolean;
  /** Version serveur connue (chaîne `updated_at` renvoyée telle quelle) ou `null`. */
  base: string | null;
}

export type PushStatus = 'ok' | 'conflict' | 'rejected' | 'deferred';

export interface PushResult {
  key: string | null;
  status: PushStatus;
  updated_at: string | null;
  deleted?: boolean;
  server_value?: unknown;
  server_deleted?: boolean;
  server_value_omitted?: boolean;
  reason?: string;
}

export interface PullChange {
  key: string;
  value: unknown;
  deleted: boolean;
  updated_at: string;
}

export interface PullPage {
  changes: PullChange[];
  has_more: boolean;
  resync_required: boolean;
  reason?: string;
}

export interface RemoteKeyState {
  value: unknown;
  deleted: boolean;
  updated_at: string;
}

export interface SyncRemote {
  /** Envoie un lot ; résultat aligné sur l'entrée. Lève SyncCallError si l'appel échoue. */
  push(items: readonly PushItem[]): Promise<PushResult[]>;
  /** `since` null = pull complet. */
  pull(since: string | null, afterKey: string, limit: number): Promise<PullPage>;
  deleteAll(): Promise<{ deleted_count: number; updated_at: string | null }>;
  /** Relit une clé (conflit avec `server_value_omitted`) ; `null` si absente. */
  fetchKey(key: string): Promise<RemoteKeyState | null>;
  /** Rafraîchit la session après un 401 ; `false` si impossible (reconnexion nécessaire). */
  refreshSession(): Promise<boolean>;
}

export type SyncCallErrorKind = 'network' | 'auth' | 'fatal';

/** Échec d'un appel entier (aucun résultat par élément). */
export class SyncCallError extends Error {
  constructor(
    readonly kind: SyncCallErrorKind,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SyncCallError';
  }
}
