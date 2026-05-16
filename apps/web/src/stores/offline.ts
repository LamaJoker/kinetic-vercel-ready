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
    _onOnline: null as (() => void) | null,
    _onOffline: null as (() => void) | null,

    init(): void {
      this._onOnline = () => {
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
      this._onOffline = () => {
        this.isOffline = true;
        this.wasOffline = false;
      };

      window.addEventListener('online', this._onOnline);
      window.addEventListener('offline', this._onOffline);

      this._timer = setInterval(() => {
        if (this.isOffline && this.lastOnlineAt) {
          this.sinceSecs = Math.floor((Date.now() - this.lastOnlineAt) / 1000);
        }
      }, 1000);
    },

    destroy(): void {
      if (this._timer) clearInterval(this._timer);
      if (this._onOnline) window.removeEventListener('online', this._onOnline);
      if (this._onOffline) window.removeEventListener('offline', this._onOffline);
    },
  };
}
