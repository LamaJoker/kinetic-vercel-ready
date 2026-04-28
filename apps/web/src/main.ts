/**
 * Kinetic — point d'entrée unique.
 * FIX: auth-ready dispatché même en guest mode
 */
import Alpine from 'alpinejs';

import { authStore }          from './stores/auth';
import { notificationsStore } from './stores/notifications';
import { xpStore }            from './stores/xp';
import { vitaliteStore }      from './stores/vitalite';
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
import './styles.css';

// ─── Stores ──────────────────────────────────────────────────
Alpine.store('notifications', notificationsStore());
Alpine.store('offline',       offlineStore());
Alpine.store('auth',          authStore());
Alpine.store('xp',            xpStore());
Alpine.store('vitalite',      vitaliteStore());
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
