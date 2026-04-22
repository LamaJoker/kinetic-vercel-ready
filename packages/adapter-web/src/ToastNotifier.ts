import type { NotifierPort, NotificationPayload } from '@kinetic/core';

/**
 * ToastNotifier — NotifierPort qui émet des événements DOM.
 *
 * Architecture événementielle : le core émet, l'UI écoute.
 * Aucun couplage entre le domaine et les bibliothèques de toast.
 *
 * L'UI Alpine doit écouter :
 *   window.addEventListener('kinetic:notify', (e) => { ... e.detail ... })
 */
export class ToastNotifier implements NotifierPort {
  notify(payload: NotificationPayload): void {
    const event = new CustomEvent('kinetic:notify', {
      detail: payload,
      bubbles: true,
    });
    window.dispatchEvent(event);
  }
}
