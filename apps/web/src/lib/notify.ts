import { STORAGE_KEYS } from '@kinetic/core';

export type NotifyKind = 'success' | 'error' | 'warning' | 'info';

/** Message bref à l'utilisateur (toast, voir ToastNotifier) : point unique de l'app. */
export function notify(kind: NotifyKind, message: string): void {
  if (typeof window === 'undefined') return; // hors navigateur (tests) : rien à afficher
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}
