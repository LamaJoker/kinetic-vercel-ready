/**
 * État de synchronisation exposé à l'application (docs/architecture/sync.md § 4.9).
 *
 * Publié par l'adaptateur (événement DOM `kinetic:sync-status`) ; l'UI l'affiche
 * en français via `syncStatusLabel` / `syncReasonLabel`. Module pur.
 */

export type SyncState = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth_required' | 'error';

export interface SyncBlockedEntry {
  readonly key: string;
  readonly reason: string;
}

export interface SyncStatus {
  readonly state: SyncState;
  /** Entrées d'outbox en attente d'envoi (hors entrées bloquées). */
  readonly pending: number;
  /** Entrées bloquées (rejet permanent du serveur) : plus de réessai automatique. */
  readonly blocked: ReadonlyArray<SyncBlockedEntry>;
  /** Éléments mis de côté (resync, réconciliation, conflit). */
  readonly recovery: number;
  readonly lastPushAt: string | null;
  readonly lastPullAt: string | null;
  readonly lastError: string | null;
  /** « Supprimer toutes mes données cloud » demandé, pas encore confirmé par le serveur. */
  readonly deleteAllPending: boolean;
  /** Synchronisation cloud active (compte connecté) ; faux en mode invité. */
  readonly enabled: boolean;
}

export const EMPTY_SYNC_STATUS: SyncStatus = Object.freeze({
  state: 'synced',
  pending: 0,
  blocked: Object.freeze([]),
  recovery: 0,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  deleteAllPending: false,
  enabled: false,
});

/** Libellé français d'une raison de blocage / de report (codes de `sync_push`). */
export function syncReasonLabel(reason: string): string {
  switch (reason) {
    case 'quota_bytes':
      return 'Espace cloud plein (50 Mo)';
    case 'quota_keys':
      return "Nombre maximal d'éléments atteint dans le cloud";
    case 'value_too_large':
      return 'Élément trop volumineux pour le cloud';
    case 'forbidden':
      return 'Accès refusé : reconnectez-vous';
    case 'invalid_key':
    case 'invalid_item':
    case 'invalid_base':
    case 'missing_value':
      return 'Élément invalide (erreur interne)';
    default:
      return reason.startsWith('internal:')
        ? `Erreur du serveur (${reason.slice('internal:'.length)})`
        : 'Erreur de synchronisation';
  }
}

/** Libellé principal de l'état de synchro (français). */
export function syncStatusLabel(status: SyncStatus): string {
  if (!status.enabled) return 'Données enregistrées sur cet appareil uniquement';
  if (status.deleteAllPending) return 'Suppression des données cloud en attente';
  switch (status.state) {
    case 'offline':
      return 'Hors ligne : vos données sont enregistrées sur cet appareil';
    case 'auth_required':
      return 'Reconnectez-vous pour synchroniser';
    case 'syncing':
      return 'Synchronisation…';
    case 'error':
      return status.blocked.length > 0
        ? `${status.blocked.length} élément${status.blocked.length > 1 ? 's' : ''} non synchronisé${status.blocked.length > 1 ? 's' : ''}`
        : 'Synchronisation interrompue, nouvel essai bientôt';
    case 'pending':
      return `${status.pending} modification${status.pending > 1 ? 's' : ''} en attente`;
    default:
      return 'Synchronisé';
  }
}

/**
 * Données « réellement » sauvegardées dans le cloud (rappel de sauvegarde, F6) :
 * rien en attente, rien de bloqué, et un envoi ou une réception réussis.
 */
export function isCloudBackedUp(status: SyncStatus): boolean {
  return (
    status.enabled &&
    status.pending === 0 &&
    status.blocked.length === 0 &&
    !status.deleteAllPending &&
    (status.lastPushAt !== null || status.lastPullAt !== null)
  );
}
