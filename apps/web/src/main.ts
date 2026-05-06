/**
 * Kinetic — point d'entrée unique.
 * FIX: auth-ready dispatché même en guest mode
 */
import Alpine from 'alpinejs';

// ─── Filets globaux : aucun crash silencieux ────────────────────────────────
// Sans ces listeners, une promesse rejetée non capturée (fetch → throw,
// Supabase → throw, plugin Capacitor → throw) reste dans la console DevTools
// mais l'utilisateur APK ne la voit jamais et le bug devient impossible à
// reproduire. On loggue + on remonte un toast pour les erreurs critiques,
// sans interrompre le flow de l'app.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === 'string' ? reason : 'Promise rejection';
    console.error('[kinetic] unhandled rejection:', reason);
    // En mode dev, persister dans un buffer lisible depuis le profil pour
    // qu'on puisse récupérer la stack même quand DevTools n'est pas connecté.
    try {
      const KEY = 'kinetic:errors';
      const prev = localStorage.getItem(KEY) ?? '';
      const stamp = new Date().toISOString();
      localStorage.setItem(KEY, `${prev}\n[${stamp}] rejection: ${msg}`.slice(-4000));
    } catch { /* localStorage indisponible — on log au moins en console */ }
  });

  window.addEventListener('error', (event) => {
    // Ignorer les erreurs ResizeObserver — bruit Chrome bénin sans impact runtime
    if (typeof event.message === 'string' && /ResizeObserver/i.test(event.message)) return;
    console.error('[kinetic] uncaught error:', event.error ?? event.message);
    try {
      const KEY = 'kinetic:errors';
      const prev = localStorage.getItem(KEY) ?? '';
      const stamp = new Date().toISOString();
      const detail = event.error instanceof Error
        ? `${event.error.name}: ${event.error.message}`
        : event.message;
      localStorage.setItem(KEY, `${prev}\n[${stamp}] error: ${detail}`.slice(-4000));
    } catch { /* ignore */ }
  });
}

import { authStore }          from './stores/auth';
import { notificationsStore } from './stores/notifications';
import { xpStore }            from './stores/xp';
import { vitaliteStore }      from './stores/vitalite';
import { rewardsStore }       from './stores/rewards';
import { offlineStore }       from './stores/offline';
import { nutritionStore }     from './stores/nutrition';
import { goalsStore }         from './stores/goals';

import { dashboard }   from './pages/dashboard.page';
import { seances }     from './pages/seances.page';
import { onboarding }  from './pages/onboarding.page';
import { progression } from './pages/progression.page';
import { bodyweight }    from './pages/bodyweight.page';
import { mensurations }  from './pages/mensurations.page';
import { nutrition }   from './pages/nutrition.page';
import { program }     from './pages/program.page';
import { profile }     from './pages/profile.page';
import { authCallback } from './pages/auth-callback.page';

import { getDeps } from './deps';

import { initRouter } from './router';
import { scheduleStreakReminder } from './lib/streak-reminder';
import { autoCompactOnStartup } from './lib/storage-maintenance';
import { runMigrationsIfNeeded } from './lib/migrations';
import { initMobile } from './lib/mobile';
import './styles.css';

// ─── Stores ──────────────────────────────────────────────────
Alpine.store('notifications', notificationsStore());
Alpine.store('offline',       offlineStore());
Alpine.store('auth',          authStore());
Alpine.store('xp',            xpStore());
Alpine.store('vitalite',      vitaliteStore());
Alpine.store('rewards',       rewardsStore());
Alpine.store('nutrition',     nutritionStore());
Alpine.store('goals',         goalsStore());

// ─── Composants Alpine ───────────────────────────────────────
Alpine.data('dashboard',   dashboard);
Alpine.data('seances',     seances);
Alpine.data('onboarding',  onboarding);
Alpine.data('progression', progression);
Alpine.data('bodyweight',  bodyweight);
Alpine.data('nutrition',   nutrition);
Alpine.data('program',     program);
Alpine.data('profile',     profile);
Alpine.data('authCallback',  authCallback);
Alpine.data('mensurations',  mensurations);

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

// Démarrer le router APRÈS Alpine.start()
// Le store auth dispatche kinetic:auth-ready dans son init()
// Le router attend cet événement avant le premier rendu
requestAnimationFrame(() => {
  initRouter();
});

void initMobile();

scheduleStreakReminder();

// Migrations schéma IDB (one-shot, idempotent) puis nettoyage bloat.
void getDeps().then(async (deps) => {
  await runMigrationsIfNeeded(deps.storage);
  await autoCompactOnStartup(deps.storage);
}).catch(() => undefined);

// Demander le stockage persistant : sans ça, iOS Safari (et Chrome sous
// pression mémoire) peut évincer IndexedDB → perte des séances enregistrées.
// `granted` requis pour que l'OS protège nos données.
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persisted().then((already) => {
    if (!already) {
      navigator.storage.persist().catch((err) => {
        console.warn('[storage] persist() failed:', err);
      });
    }
  }).catch(() => undefined);
}
