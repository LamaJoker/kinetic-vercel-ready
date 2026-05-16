/**
 * Store Alpine `offline` — état de connexion réseau.
 * Usage : <div x-show="$store.offline.isOffline">…</div>
 */
export function offlineStore() {
  return {
    isOffline: !navigator.onLine,
    wasOffline: false,
    lastOnlineAt: navigator.onLine ? Date.now() : (null as number | null),
    sinceSecs: 0,
    _timer: null as ReturnType<typeof setInterval> | null,

    init(): void {
      const onOnline = () => {
        this.wasOffline = this.isOffline;
        this.isOffline = false;
        this.lastOnlineAt = Date.now();
        this.sinceSecs = 0;
        if (this.wasOffline) {
          setTimeout(() => {
            this.wasOffline = false;
          }, 3000);
        }
      };
      const onOffline = () => {
        this.isOffline = true;
        this.wasOffline = false;
      };

      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      this._timer = setInterval(() => {
        if (this.isOffline && this.lastOnlineAt) {
          this.sinceSecs = Math.floor((Date.now() - this.lastOnlineAt) / 1000);
        }
      }, 1000);
    },

    destroy(): void {
      if (this._timer) clearInterval(this._timer);
    },
  };
}
