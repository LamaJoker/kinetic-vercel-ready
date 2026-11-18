/**
 * Bandeau « Séance en cours · <nom> · <durée> » : visible sur les autres écrans
 * tant qu'une séance n'est ni sauvegardée ni abandonnée, il ramène à la page
 * Séances d'un toucher. Monté dans index.html (au-dessus de la barre d'onglets).
 *
 * Source : la clé TRAINING_ACTIVE_SESSION (lue au démarrage) puis l'événement
 * EVENT_ACTIVE_SESSION_CHANGED émis par la page Séances à chaque changement.
 */
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../deps';
import {
  type ActiveSessionSummary,
  formatActiveDuration,
  loadActiveSession,
  summarizeActiveSession,
} from '../lib/training/active-session';

const HIDDEN_PATHS = ['/seances', '/onboarding', '/login', '/auth-callback', '/auth/callback'];

/** Vrai si le bandeau doit s'afficher pour cette séance sur ce chemin. */
export function shouldShowActiveBanner(
  summary: ActiveSessionSummary | null,
  path: string,
): boolean {
  if (!summary) return false;
  const p = path.replace(/\/+$/, '') || '/';
  return !HIDDEN_PATHS.includes(p) && !p.startsWith('/legal/');
}

export function activeSessionBanner() {
  return {
    summary: null as ActiveSessionSummary | null,
    path: typeof window !== 'undefined' ? window.location.pathname : '/',
    nowMs: Date.now(),
    _tick: null as ReturnType<typeof setInterval> | null,
    /** Incrémenté à chaque événement : une lecture du stockage plus ancienne ne l'écrase pas. */
    _version: 0,

    init(): void {
      void this.reload();
      window.addEventListener(STORAGE_KEYS.EVENT_ACTIVE_SESSION_CHANGED, (e: Event) => {
        this._version++;
        this.setSummary((e as CustomEvent<ActiveSessionSummary | null>).detail ?? null);
      });
      window.addEventListener(STORAGE_KEYS.EVENT_ROUTE_CHANGED, (e: Event) => {
        const detail = (e as CustomEvent<{ path?: string }>).detail;
        this.path = detail?.path ?? window.location.pathname;
      });
      window.addEventListener(STORAGE_KEYS.EVENT_AUTH_CHANGED, () => void this.reload());
    },

    async reload(): Promise<void> {
      const version = this._version;
      try {
        const deps = await getDeps();
        const snap = await loadActiveSession(deps.storage);
        if (version === this._version) this.setSummary(summarizeActiveSession(snap));
      } catch {
        /* stockage indisponible : pas de bandeau */
      }
    },

    setSummary(summary: ActiveSessionSummary | null): void {
      this.summary = summary;
      this.nowMs = Date.now();
      if (summary && this._tick === null) {
        this._tick = setInterval(() => {
          this.nowMs = Date.now();
        }, 1000);
      } else if (!summary && this._tick !== null) {
        clearInterval(this._tick);
        this._tick = null;
      }
    },

    visible(): boolean {
      return shouldShowActiveBanner(this.summary, this.path);
    },

    name(): string {
      return this.summary?.name ?? '';
    },

    duration(): string {
      return this.summary ? formatActiveDuration(this.summary.startedAt, this.nowMs) : '';
    },

    /** Le bandeau masque le bas de la page : on rallonge la marge de l'outlet tant qu'il est là. */
    syncOutletPadding(): void {
      const outlet = typeof document !== 'undefined' ? document.getElementById('app-outlet') : null;
      if (outlet) outlet.style.paddingBottom = this.visible() ? '10rem' : '';
    },

    ariaLabel(): string {
      return this.summary
        ? `Séance en cours : ${this.summary.name}, ${this.duration()}. Revenir à la séance.`
        : '';
    },
  };
}
