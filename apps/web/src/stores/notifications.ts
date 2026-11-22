import { STORAGE_KEYS } from '@kinetic/core';

/**
 * Store Alpine `notifications` — toasts.
 */
interface NotificationPayload {
  kind: 'success' | 'error' | 'warning' | 'info';
  message: string;
  duration?: number;
}

type Toast = NotificationPayload & { id: number; visible: boolean };

/** Durée par défaut d'une notification (ms). */
export const TOAST_MS = 3500;
/** Mode salle : notification raccourcie (elle se pose sous le nom de l'exercice). */
export const STAGE_TOAST_MS = 2000;

/**
 * Durée d'affichage : raccourcie en mode salle (écran plein format), sauf pour
 * une erreur qu'il faut avoir le temps de lire.
 */
export function toastDuration(
  payload: Pick<NotificationPayload, 'kind' | 'duration'>,
  inStage: boolean,
): number {
  const d = payload.duration ?? TOAST_MS;
  return inStage && payload.kind !== 'error' ? Math.min(d, STAGE_TOAST_MS) : d;
}

/** Écran « Mode salle » affiché (seances.html, section .k-stage). */
function stageShown(): boolean {
  try {
    return !!document.querySelector('.k-stage:not([style*="display: none"])');
  } catch {
    return false;
  }
}

export function notificationsStore() {
  return {
    toasts: [] as Toast[],
    _counter: 0,
    // M3 FIX: handler stocké pour removeEventListener dans destroy()
    _notifyHandler: null as ((e: Event) => void) | null,

    init(): void {
      this._notifyHandler = (e: Event) => {
        const payload = (e as CustomEvent<NotificationPayload>).detail;
        if (payload) this.push(payload);
      };
      window.addEventListener(STORAGE_KEYS.EVENT_NOTIFY, this._notifyHandler);
    },

    destroy(): void {
      if (this._notifyHandler) {
        window.removeEventListener(STORAGE_KEYS.EVENT_NOTIFY, this._notifyHandler);
        this._notifyHandler = null;
      }
    },

    push(payload: NotificationPayload): void {
      const id = ++this._counter;
      const toast: Toast = { ...payload, id, visible: true };
      this.toasts = [...this.toasts, toast];

      const duration = toastDuration(payload, stageShown());
      setTimeout(() => {
        this.toasts = this.toasts.map((t) => (t.id === id ? { ...t, visible: false } : t));
        setTimeout(() => {
          this.toasts = this.toasts.filter((t) => t.id !== id);
        }, 300);
      }, duration);
    },

    dismiss(id: number): void {
      this.toasts = this.toasts.map((t) => (t.id === id ? { ...t, visible: false } : t));
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, 300);
    },

    /**
     * Mode salle : texte de la dernière notification visible, affiché dans l'écran
     * plein format sous le nom de l'exercice (la pile habituelle y est masquée à
     * l'œil mais reste annoncée aux lecteurs d'écran). Vide sinon.
     */
    stageToast(): string {
      for (let i = this.toasts.length - 1; i >= 0; i--) {
        const t = this.toasts[i]!;
        if (t.visible) return t.message;
      }
      return '';
    },

    /** Couleur de la pastille d'état affichée dans le toast. */
    kindClass(kind: string): string {
      return (
        (
          {
            success: 'bg-kinetic-teal',
            error: 'bg-kinetic-electric',
            warning: 'bg-kinetic-neon',
            info: 'bg-kinetic-purple',
          } as Record<string, string>
        )[kind] ?? 'bg-kinetic-purple'
      );
    },
  };
}
