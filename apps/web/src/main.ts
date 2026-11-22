/**
 * Kinetic — point d'entrée unique.
 * FIX: auth-ready dispatché même en guest mode
 */
import Alpine from 'alpinejs';
import { STORAGE_KEYS, resetDailyTasks, decodeWorkout } from '@kinetic/core';

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
import { achievementsStore } from './stores/achievements';
import { registerSvgDirective } from './lib/svg-directive';
import { registerCountDirective } from './lib/count-up';
import { registerLazyDirectives } from './lib/lazy-directives';
import { registerChipScrollDirective } from './lib/chip-scroll';
import { plural } from './lib/plural';
import { num } from './lib/num';

import { activeSessionBanner } from './components/active-session-banner';
import { initPwaInstallPrompt, pwaInstallPrompt } from './lib/pwa-install';
import { initTheme } from './lib/theme';
import { initDisplayDensity } from './lib/display-mode';

// ─── Theme + densité : appliquer avant tout pour éviter le flash ─────────
initTheme();
initDisplayDensity();

import { getDeps } from './deps';

import { initRouter } from './router';
import { scheduleStreakReminder } from './lib/streak-reminder';
import { Capacitor } from '@capacitor/core';
import { syncWeeklyRecap, syncSessionReminder, syncBackupReminder } from './lib/reminders';
import { localIsoDate } from './lib/widget';
import { autoCompactOnStartup } from './lib/storage-maintenance';
import { runMigrationsIfNeeded } from './lib/migrations';
import { initMobile } from './lib/mobile';
import { initAnalytics } from './lib/analytics';
import { celebration } from './lib/celebration';
import './styles.css';
import './styles/native-feel.css';
import './styles/finitions.css';
import './styles/celebrations.css';
import './styles/gestes.css';

// ─── Stores ──────────────────────────────────────────────────
// Directive x-svg : remplace x-html, interdit par le build CSP d'Alpine.
registerSvgDirective(Alpine as never);
// x-count : chiffres qui défilent (à côté d'un x-text) ; x-scrub, x-swipe, x-hold :
// courbes au doigt, lignes à glisser, appui maintenu (code chargé à la demande).
registerCountDirective(Alpine as never);
registerLazyDirectives(Alpine as never);
// x-chip-scroll : rangée de pastilles défilante (onglets à 5-6 choix).
registerChipScrollDirective(Alpine as never);
// $plural(n, 'séance') → « 3 séances » (fin des « séance(s) »)
(Alpine as unknown as { magic(name: string, cb: () => unknown): void }).magic(
  'plural',
  () => plural,
);
// Le build CSP n'expose pas les globales (Math, Date) aux expressions :
// $num.round(x) (nos propres fonctions, pas l'objet Math) et $today.
(Alpine as unknown as { magic(name: string, cb: () => unknown): void }).magic('num', () => num);
(Alpine as unknown as { magic(name: string, cb: () => unknown): void }).magic('today', () =>
  new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
);

Alpine.store('notifications', notificationsStore());
Alpine.store('offline', offlineStore());
Alpine.store('auth', authStore());
Alpine.store('xp', xpStore());
Alpine.store('vitalite', vitaliteStore());
Alpine.store('rewards', rewardsStore());
Alpine.store('nutrition', nutritionStore());
Alpine.store('goals', goalsStore());
Alpine.store('achievements', achievementsStore());

// ─── Composants Alpine ───────────────────────────────────────
// Seuls ceux du shell (index.html) sont ici. Ceux des pages sont chargés à la
// demande avec leur gabarit (page-components.ts) : ne pas les importer ici.
Alpine.data('activeSessionBanner', activeSessionBanner); // bandeau « Séance en cours » (index.html)
Alpine.data('pwaInstallPrompt', pwaInstallPrompt);
Alpine.data('celebration', celebration); // célébrations (record, niveau), monté dans index.html

// ─── PWA install bus (capture beforeinstallprompt avant qu'Alpine init) ─────
initPwaInstallPrompt();

// ─── Error reporter (best effort, throttlé 30 min) ──────────────────────────
import('./lib/error-reporter')
  .then(({ initErrorReporter }) => initErrorReporter())
  .catch(() => null);

// ─── Écran allumé pendant une séance en cours (Wake Lock, silencieux si absent) ─
import('./lib/wake-lock')
  .then(({ initSessionWakeLock }) => initSessionWakeLock())
  .catch(() => null);

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
  /** Rang de l'onglet actif (0 à 4), ou -1 hors des cinq pages racines. */
  tabIndex(this: { currentPath: string }) {
    const p = this.currentPath;
    if (p === '/') return 0;
    if (p === '/seances') return 1;
    if (p === '/bodyweight' || p === '/mensurations') return 2;
    if (p === '/vitalite') return 3;
    if (p === '/profile') return 4;
    return -1;
  },
  /** Pastille active de la barre d'onglets : glisse sous l'onglet courant
   *  (styles.css → .k-tab-pill ; seule la transformation est animée). */
  tabPillStyle(this: { currentPath: string; tabIndex: () => number }) {
    const i = this.tabIndex();
    return i < 0
      ? 'opacity: 0; transform: translateX(200%) scale(0.6)'
      : `opacity: 1; transform: translateX(${i * 100}%)`;
  },
  /** Écrans plein cadre (onboarding, connexion) : pas de barre de navigation. */
  isChromeless(this: { currentPath: string }) {
    return (
      ['/onboarding', '/login', '/auth-callback', '/auth/callback'].includes(this.currentPath) ||
      this.currentPath.startsWith('/legal/')
    );
  },
}));

// ─── Composants inline → Alpine.data (requis par @alpinejs/csp) ─────────────
// Ces composants remplacent les expressions x-data="{ ... }" inline dans
// les templates HTML. Le build CSP interdit eval() / new Function() ; toute
// logique JS doit être pré-enregistrée ici.

/** Lit (et consomme) le drapeau posé après la suppression du compte. */
function consumeAccountDeletedFlag(): boolean {
  try {
    const v = sessionStorage.getItem(STORAGE_KEYS.ACCOUNT_DELETED) === '1';
    sessionStorage.removeItem(STORAGE_KEYS.ACCOUNT_DELETED);
    return v;
  } catch {
    return false;
  }
}

Alpine.data('loginPage', () => ({
  accountDeleted: consumeAccountDeletedFlag(),
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

// ─── Chunk introuvable après un déploiement ─────────────────
// Un onglet ouvert sur une ancienne version peut demander un chunk qui n'existe
// plus. Vite émet alors `vite:preloadError` : on recharge UNE fois pour récupérer
// la nouvelle version (garde anti-boucle en sessionStorage).
window.addEventListener('vite:preloadError', (event) => {
  const GUARD = STORAGE_KEYS.PRELOAD_RELOAD_AT;
  try {
    const last = Number(sessionStorage.getItem(GUARD) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(GUARD, String(Date.now()));
  } catch {
    /* sessionStorage indisponible : on tente quand même un rechargement */
  }
  event.preventDefault();
  window.location.reload();
});

// ─── Service Worker (prod) ───────────────────────────────────
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[SW] registration failed:', err);
    });
  });
}

// ─── Import de séance partagée par URL ──────────────────────────────────────
// Détecte `?import=<token>` au boot, décode, et stocke en sessionStorage pour
// que la page Séances l'attrape au prochain rendu. On nettoie l'URL pour ne
// pas re-importer en boucle si l'utilisateur navigue.
try {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('import');
  if (token) {
    const workout = decodeWorkout(token);
    if (workout) {
      sessionStorage.setItem(STORAGE_KEYS.PENDING_SHARED_IMPORT, JSON.stringify(workout));
      params.delete('import');
      const cleanQs = params.toString();
      const cleanUrl =
        window.location.pathname + (cleanQs ? '?' + cleanQs : '') + window.location.hash;
      window.history.replaceState(null, '', cleanUrl);
    } else {
      console.warn('[kinetic] shared workout token invalid');
    }
  }
} catch (err) {
  console.warn('[kinetic] shared import detection failed:', err);
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

// Application Android : rappels reprogrammés au lancement et à chaque mise en
// arrière-plan (les séances du jour sont alors comptées) ; pas et sommeil relus
// dans Health Connect au retour dans l'application.
function cloudSynced(): boolean {
  const auth = Alpine.store('auth') as { isAuthenticated: boolean; isGuest: boolean };
  return auth.isAuthenticated && !auth.isGuest;
}
function syncReminders(): void {
  void syncWeeklyRecap();
  void syncSessionReminder();
  void syncBackupReminder(cloudSynced());
  // Rappel « protéines du soir » : module chargé à la demande, appli installée seulement.
  if (Capacitor.isNativePlatform())
    void import('./lib/protein-reminder').then((m) => m.syncProteinReminder());
}
window.addEventListener(STORAGE_KEYS.EVENT_AUTH_READY, syncReminders, { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') syncReminders();
  else void (Alpine.store('vitalite') as { syncHealth(): Promise<void> }).syncHealth();
});
window.addEventListener(STORAGE_KEYS.EVENT_SESSION_SAVED, () => void syncSessionReminder());
window.addEventListener(STORAGE_KEYS.EVENT_STREAK_UPDATED, () => {
  (Alpine.store('vitalite') as { _syncNative(): void })._syncNative();
});

// Passage à un nouveau jour, application restée ouverte : la routine repart de zéro.
let currentDay = localIsoDate();
async function refreshOnNewDay(): Promise<void> {
  const today = localIsoDate();
  if (today === currentDay) return;
  currentDay = today;
  try {
    const deps = await getDeps();
    await resetDailyTasks({ storage: deps.storage, clock: deps.clock });
    await (Alpine.store('vitalite') as { init(): Promise<void> }).init();
  } catch (err) {
    console.warn('[kinetic] new-day refresh failed:', err);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshOnNewDay();
});

// Application native : sauvegarde automatique hebdomadaire dans Documents, au
// démarrage et au retour au premier plan (sans effet sur le web).
function autoBackup(): void {
  // Module chargé à part : inutile au premier écran (et sans effet sur le web).
  void Promise.all([getDeps(), import('./lib/auto-backup')])
    .then(([deps, { runAutoBackup }]) => runAutoBackup(deps.storage))
    .catch(() => undefined);
}
setTimeout(autoBackup, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoBackup();
});
setInterval(() => void refreshOnNewDay(), 60_000);

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
