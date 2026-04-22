/**
 * NotifierPort — émission de notifications utilisateur.
 *
 * Le domaine émet des notifications sans connaître l'UI.
 * L'UI écoute et affiche (toast, banner, etc.).
 *
 * Implémentations : ToastNotifier (DOM events), SilentNotifier (tests).
 */
export type NotificationKind = 'success' | 'error' | 'warning' | 'info';

export interface NotificationPayload {
  kind:      NotificationKind;
  message:   string;
  duration?: number; // ms, défaut 3500
}

export interface NotifierPort {
  notify(payload: NotificationPayload): void;
}
