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

import { dashboard }  from './pages/dashboard.page';
import { seances }    from './pages/seances.page';
import { onboarding } from './pages/onboarding.page';

import { getDeps }                     from './deps';
import { exportAsJson, exportAsCsv }   from './lib/training/export';
import { mealTimingPlan }              from '@kinetic/core';

import { initRouter } from './router';
import './styles.css';

// ─── Stores ──────────────────────────────────────────────────
Alpine.store('notifications', notificationsStore());
Alpine.store('offline',       offlineStore());
Alpine.store('auth',          authStore());
Alpine.store('xp',            xpStore());
Alpine.store('vitalite',      vitaliteStore());
Alpine.store('nutrition',     nutritionStore());

// ─── Composants Alpine ───────────────────────────────────────
Alpine.data('dashboard', dashboard);
Alpine.data('seances',   seances);
Alpine.data('onboarding', onboarding);

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

// ─── Globals pour scripts inline des pages HTML ──────────────
// Les <script> injectés via innerHTML sont des scripts classiques qui ne
// peuvent pas faire `import(...)` de modules hashés par Vite. On expose les
// helpers nécessaires sur window.__kinetic.
window.__kinetic = { getDeps, exportAsJson, exportAsCsv, mealTimingPlan };

// ─── Démarrage ───────────────────────────────────────────────
Alpine.start();

// Démarrer le router APRÈS Alpine.start()
// Le store auth dispatche kinetic:auth-ready dans son init()
// Le router attend cet événement avant le premier rendu
requestAnimationFrame(() => {
  initRouter();
});
