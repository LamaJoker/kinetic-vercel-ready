/**
 * Kinetic — point d'entrée unique.
 */
import Alpine from 'alpinejs';

// Stores — s'enregistrent sur Alpine.store('name', …)
import { authStore }          from './stores/auth';
import { notificationsStore } from './stores/notifications';
import { xpStore }            from './stores/xp';
import { vitaliteStore }      from './stores/vitalite';
import { offlineStore }       from './stores/offline';
import { nutritionStore }     from './stores/nutrition'; // Ajout

// Composants Alpine pour pages avec logique locale
import { dashboard } from './pages/dashboard.page';
import { seances }   from './pages/seances.page';
import { onboarding } from './pages/onboarding.page';

// Router
import { initRouter } from './router';

// Styles (Tailwind via PostCSS)
import './styles.css';

// ─── Registration ────────────────────────────────────────────
Alpine.store('notifications', notificationsStore());
Alpine.store('offline',       offlineStore());
Alpine.store('auth',          authStore());
Alpine.store('xp',            xpStore());
Alpine.store('vitalite',      vitaliteStore());
Alpine.store('nutrition',     nutritionStore()); // Enregistrement

Alpine.data('dashboard', dashboard);
Alpine.data('seances',   seances);
Alpine.data('onboarding', onboarding);

// ─── Service Worker (prod uniquement) ────────────────────────
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[SW] registration failed:', err);
    });
  });
}

// ─── Expose Alpine avant start ───────────────────────────────
declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;

// ─── Démarrage ───────────────────────────────────────────────
Alpine.start();
initRouter();