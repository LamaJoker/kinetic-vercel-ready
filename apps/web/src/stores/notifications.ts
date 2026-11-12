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

      const duration = payload.duration ?? 3500;
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
