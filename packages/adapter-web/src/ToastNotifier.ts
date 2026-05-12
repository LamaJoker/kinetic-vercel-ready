import type { NotifierPort, NotificationPayload } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';

/**
 * ToastNotifier — NotifierPort qui émet des événements DOM.
 *
 * Architecture événementielle : le core émet, l'UI écoute.
 * Aucun couplage entre le domaine et les bibliothèques de toast.
 *
 * L'UI Alpine doit écouter :
 *   window.addEventListener(STORAGE_KEYS.EVENT_NOTIFY, (e) => { ... e.detail ... })
 */
export class ToastNotifier implements NotifierPort {
  notify(payload: NotificationPayload): void {
    const event = new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
      detail: payload,
      bubbles: true,
    });
    window.dispatchEvent(event);
  }
}
