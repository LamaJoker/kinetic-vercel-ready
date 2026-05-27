/**
 * Kinetic — point d'entrée unique.
 * FIX: auth-ready dispatché même en guest mode
 */
import Alpine from 'alpinejs';
import { STORAGE_KEYS, resetDailyTasks } from '@kinetic/core';

// ─── Redirect vers le domaine canonique ─────────────────────────────────────
// Vercel génère une URL preview unique par déploiement (kinetic-prod-XXX-...).
// Si l'utilisateur arrive sur une de ces URLs (lien direct, partage, etc.),
// son localStorage est isolé de la prod → la session ne persiste pas quand il
// revient ensuite sur kinetic-prod.vercel.app. On force la redirection EN
// PREMIER, avant tout import lourd ou init Alpine, en préservant le path/hash.
if (
  typeof window !== 'undefined' &&
  /^kinetic-prod-[a-z0-9-]+\.vercel\.app$/.test(window.location.hostname) &&
  window.location.hostname !== 'kinetic-prod.vercel.app'
) {
  window.location.replace(
    'https://kinetic-prod.vercel.app' +
      window.location.pathname +
      window.location.search +
      window.location.hash,
  );
  throw new Error('[kinetic] redirecting to canonical domain'); // empêche l'init en double
}

// ─── Filets globaux : aucun crash silencieux ────────────────────────────────
// Sans ces listeners, une promesse rejetée non capturée (fetch → throw,
// Supabase → throw, plugin Capacitor → throw) reste dans la console DevTools
// mais l'utilisateur APK ne la voit jamais et le bug devient impossible à
// reproduire. On loggue + on remonte un toast pour les erreurs critiques,
// sans interrompre le flow de l'app.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : typeof reason === 'string'
          ? reason
          : 'Promise rejection';
    console.error('[kinetic] unhandled rejection:', reason);
    // En mode dev, persister dans un buffer lisible depuis le profil pour
    // qu'on puisse récupérer la stack même quand DevTools n'est pas connecté.
    try {
      const KEY = STORAGE_KEYS.ERRORS;
      const prev = localStorage.getItem(KEY) ?? '';
      const stamp = new Date().toISOString();
      localStorage.setItem(KEY, `${prev}\n[${stamp}] rejection: ${msg}`.slice(-4000));
    } catch {
      /* localStorage indisponible — on log au moins en console */
    }
  });

  window.addEventListener('error', (event) => {
    // Ignorer les erreurs ResizeObserver — bruit Chrome bénin sans impact runtime
    if (typeof event.message === 'string' && /ResizeObserver/i.test(event.message)) return;
    console.error('[kinetic] uncaught error:', event.error ?? event.message);
    try {
      const KEY = STORAGE_KEYS.ERRORS;
      const prev = localStorage.getItem(KEY) ?? '';
      const stamp = new Date().toISOString();
      const detail =
        event.error instanceof Error
          ? `${event.error.name}: ${event.error.message}`
          : event.message;
      localStorage.setItem(KEY, `${prev}\n[${stamp}] error: ${detail}`.slice(-4000));
    } catch {
      /* ignore */
    }
  });
}

import { authStore } from './stores/auth';
import { notificationsStore } from './stores/notifications';
import { xpStore } from './stores/xp';
import { vitaliteStore } from './stores/vitalite';
import { rewardsStore } from './stores/rewards';
import { offlineStore } from './stores/offline';
import { nutritionStore } from './stores/nutrition';
import { goalsStore } from './stores/goals';

import { dashboard } from './pages/dashboard.page';
import { seances } from './pages/seances.page';
import { onboarding } from './pages/onboarding.page';
import { progression } from './pages/progression.page';
import { bodyweight } from './pages/bodyweight.page';
import { mensurations } from './pages/mensurations.page';
import { nutrition } from './pages/nutrition.page';
import { program } from './pages/program.page';
import { profile } from './pages/profile.page';
import { records } from './pages/records.page';
import { authCallback } from './pages/auth-callback.page';

import { getDeps } from './deps';

import { initRouter } from './router';
import { scheduleStreakReminder } from './lib/streak-reminder';
import { autoCompactOnStartup } from './lib/storage-maintenance';
import { runMigrationsIfNeeded } from './lib/migrations';
import { initMobile } from './lib/mobile';
import { initAnalytics } from './lib/analytics';
import './styles.css';

// ─── Stores ──────────────────────────────────────────────────
Alpine.store('notifications', notificationsStore());
Alpine.store('offline', offlineStore());
Alpine.store('auth', authStore());
Alpine.store('xp', xpStore());
Alpine.store('vitalite', vitaliteStore());
Alpine.store('rewards', rewardsStore());
Alpine.store('nutrition', nutritionStore());
Alpine.store('goals', goalsStore());

// ─── Composants Alpine ───────────────────────────────────────
Alpine.data('dashboard', dashboard);
Alpine.data('seances', seances);
Alpine.data('onboarding', onboarding);
Alpine.data('progression', progression);
Alpine.data('bodyweight', bodyweight);
Alpine.data('nutrition', nutrition);
Alpine.data('program', program);
Alpine.data('profile', profile);
Alpine.data('records', records);
Alpine.data('authCallback', authCallback);
Alpine.data('mensurations', mensurations);

// ─── Shell de la page (body x-data) ─────────────────────────────────────────
// Remplace x-data="{ currentPath: location.pathname }" dans index.html.
// Le build CSP ne peut pas évaluer les globaux (location) en inline x-data ;
// tout doit être pré-enregistré ici.
Alpine.data('navShell', () => ({
  currentPath: typeof window !== 'undefined' ? window.location.pathname : '/',
  setPath(this: { currentPath: string }, path: string) {
    this.currentPath = path;
  },
  isBodyPage(this: { currentPath: string }) {
    return this.currentPath === '/bodyweight' || this.currentPath === '/mensurations';
  },
}));

// ─── Composants inline → Alpine.data (requis par @alpinejs/csp) ─────────────
// Ces composants remplacent les expressions x-data="{ ... }" inline dans
// les templates HTML. Le build CSP interdit eval() / new Function() ; toute
// logique JS doit être pré-enregistrée ici.

Alpine.data('loginPage', () => ({
  emailMode: false,
}));

Alpine.data('authDebugPanel', () => {
  let log = '';
  try {
    log = localStorage.getItem(STORAGE_KEYS.AUTH_DEBUG) ?? '';
  } catch {
    /* localStorage indisponible (iOS privé) */
  }
  return {
    log,
    show: false,
    clearLog(this: { log: string }) {
      try {
        localStorage.removeItem(STORAGE_KEYS.AUTH_DEBUG);
      } catch {
        /* ignore */
      }
      this.log = '';
    },
  };
});

Alpine.data('authDiagPanel', () => ({
  show: false,
  origin: '',
  href: '',
  callbackUrl: '' as string,
  supabaseUrl: '' as string,
  init(this: Record<string, unknown>) {
    if (typeof window !== 'undefined') {
      (this as { origin: string }).origin = window.location.origin;
      (this as { href: string }).href = window.location.href;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (this as any).$store?.auth;
    (this as { callbackUrl: string }).callbackUrl =
      auth?._diagCallbackUrl?.() ?? '(non disponible)';
    (this as { supabaseUrl: string }).supabaseUrl = auth?._diagSupabaseUrl?.() ?? '(non configuré)';
  },
}));

Alpine.data('levelUpOverlay', () => ({
  show: false,
  level: 0,
  title: '',
  _timer: null as ReturnType<typeof setTimeout> | null,
  init(this: {
    show: boolean;
    level: number;
    title: string;
    _timer: ReturnType<typeof setTimeout> | null;
  }) {
    window.addEventListener(STORAGE_KEYS.EVENT_LEVELUP, (e) => {
      const detail = (e as CustomEvent<{ level: number; title: string }>).detail;
      this.level = detail.level;
      this.title = detail.title;
      this.show = true;
      if (this._timer !== null) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this.show = false;
      }, 4500);
    });
  },
}));

// ─── Service Worker (prod) ───────────────────────────────────
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[SW] registration failed:', err);
    });
  });
}

// ─── Exposition globale Alpine ───────────────────────────────
window.Alpine = Alpine;

// ─── Démarrage ───────────────────────────────────────────────
Alpine.start();
initAnalytics();

// Démarrer le router APRÈS Alpine.start()
// Le store auth dispatche kinetic:auth-ready dans son init()
// Le router attend cet événement avant le premier rendu
requestAnimationFrame(() => {
  initRouter();
});

void initMobile();

scheduleStreakReminder();

// Migrations schéma IDB, reset quotidien des tâches, puis nettoyage bloat.
void getDeps()
  .then(async (deps) => {
    await runMigrationsIfNeeded(deps.storage);
    await resetDailyTasks({ storage: deps.storage, clock: deps.clock });
    await autoCompactOnStartup(deps.storage);
  })
  .catch(() => undefined);

// Demander le stockage persistant : sans ça, iOS Safari (et Chrome sous
// pression mémoire) peut évincer IndexedDB → perte des séances enregistrées.
// `granted` requis pour que l'OS protège nos données.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage
    .persisted()
    .then((already) => {
      if (!already) {
        navigator.storage.persist().catch((err) => {
          console.warn('[storage] persist() failed:', err);
        });
      }
    })
    .catch(() => undefined);
}
