/**
 * Store Alpine `notifications` — toasts.
 * Écoute `kinetic:notify` et maintient une file de toasts.
 */
interface NotificationPayload {
  kind:      'success' | 'error' | 'warning' | 'info';
  message:   string;
  duration?: number;
}

type Toast = NotificationPayload & { id: number; visible: boolean };

export function notificationsStore() {
  return {
    toasts:   [] as Toast[],
    _counter: 0,

    init(): void {
      window.addEventListener('kinetic:notify', (e: Event) => {
        const payload = (e as CustomEvent<NotificationPayload>).detail;
        if (payload) this.push(payload);
      });
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

    kindClass(kind: string): string {
      return ({
        success: 'bg-kinetic-teal',
        error:   'bg-red-500',
        warning: 'bg-amber-500',
        info:    'bg-kinetic-purple',
      } as Record<string, string>)[kind] ?? 'bg-gray-600';
    },
  };
}
