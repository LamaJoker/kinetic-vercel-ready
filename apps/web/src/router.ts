/**
 * SPA Router - History API + pages bundled by Vite.
 * FIX #2: Route /auth-callback alignée avec callbackUrl() dans auth.ts
 * FIX #3: Hash URL préservé avant navigation pour les magic links
 */
import Alpine from 'alpinejs';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from './deps';
import { ric } from './lib/performance';

const PAGE_MODULES = import.meta.glob('./pages/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type RouteKey =
  | '/'
  | '/onboarding'
  | '/seances'
  | '/vitalite'
  | '/nutrition'
  | '/program'
  | '/login'
  | '/profile'
  | '/auth-callback' // ← FIX #2 : était '/auth/callback' — aligné avec callbackUrl()
  | '/bodyweight'
  | '/progression'
  | '/mensurations'
  | '/records'
  | '/plates'
  | '/achievements';

const ROUTES: Record<RouteKey, string> = {
  '/': './pages/dashboard.html',
  '/onboarding': './pages/onboarding.html',
  '/seances': './pages/seances.html',
  '/vitalite': './pages/vitalite.html',
  '/nutrition': './pages/nutrition.html',
  '/program': './pages/program.html',
  '/login': './pages/login.html',
  '/profile': './pages/profile.html',
  '/auth-callback': './pages/auth-callback.html', // ← FIX #2
  '/bodyweight': './pages/bodyweight.html',
  '/progression': './pages/progression.html',
  '/mensurations': './pages/mensurations.html',
  '/records': './pages/records.html',
  '/plates': './pages/plates.html',
  '/achievements': './pages/achievements.html',
};

const ONBOARDING_EXEMPT: readonly RouteKey[] = ['/onboarding', '/login', '/auth-callback'];

const outlet = (): HTMLElement => {
  const el = document.getElementById('app-outlet');
  if (!el) throw new Error('[router] #app-outlet not found');
  return el;
};

const NOT_FOUND_HTML = `
  <div class="min-h-screen flex items-center justify-center p-8 text-center">
    <div>
      <p class="text-5xl mb-3">404</p>
      <p class="text-gray-300 font-medium mb-1">Page introuvable</p>
      <a href="/" class="text-kinetic-purple underline text-sm">Retour au dashboard</a>
    </div>
  </div>`;

function resolveHtml(path: string): string {
  const file = ROUTES[path as RouteKey];
  if (!file) return NOT_FOUND_HTML;
  return PAGE_MODULES[file] ?? NOT_FOUND_HTML;
}

let _onboardingKnown: boolean | null = null;

async function hasCompletedOnboarding(): Promise<boolean> {
  // E2E test override: allow tests to skip the IDB onboarding check without
  // having to write USER_PROFILE to IDB (which causes a persistent IDB
  // connection hang on mobile-safari/WebKit CI when set from a test context).
  // Set via page.addInitScript() before app code runs.
  if (
    typeof window !== 'undefined' &&
    (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding === true
  ) {
    _onboardingKnown = true;
    return true;
  }
  if (_onboardingKnown !== null) return _onboardingKnown;
  try {
    const deps = await getDeps();
    const profile = await deps.storage.get(STORAGE_KEYS.USER_PROFILE);
    _onboardingKnown = Boolean(profile);
    return _onboardingKnown;
  } catch {
    _onboardingKnown = true;
    return true;
  }
}

async function render(path: string): Promise<void> {
  // FIX #3 : Préserver le hash AVANT toute navigation — Supabase en a besoin
  // pour les magic links et OAuth (tokens dans le fragment #access_token=...)
  const hash = window.location.hash;
  const normalizedPath = (path || '/').split('?')[0]!;

  // Si le path est /auth-callback, on laisse toujours passer sans
  // vérification onboarding — le hash contient les tokens OAuth
  if (!ONBOARDING_EXEMPT.includes(normalizedPath as RouteKey)) {
    try {
      const ok = await hasCompletedOnboarding();
      if (!ok && normalizedPath !== '/onboarding') {
        navigate('/onboarding', true);
        return;
      }
    } catch {
      // Ne pas bloquer en cas d'erreur
    }
  }

  const host = outlet();
  host.style.opacity = '0.6';
  host.setAttribute('aria-busy', 'true');

  host.querySelectorAll<HTMLElement>('[x-data]').forEach((el) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (el as any)._x_dataStack?.[0];
    if (data && typeof data.destroy === 'function') {
      try {
        data.destroy();
      } catch (err) {
        console.warn('[router] component destroy failed:', err);
      }
    }
  });

  host.innerHTML = resolveHtml(normalizedPath);

  // FIX #3 : Restaurer le hash après injection du HTML pour que Supabase Auth JS
  // puisse le lire lors de l'init du composant auth-callback
  if (hash && normalizedPath === '/auth-callback') {
    // Ne pas utiliser history.replaceState ici — ça effacerait le hash dont
    // Supabase a besoin. On laisse le hash intact dans la barre d'adresse.
    // Alpine init se fait avec le hash toujours présent dans window.location.hash
  }

  try {
    Alpine.initTree(host);
  } catch (e) {
    console.warn('[router] Alpine.initTree failed:', e);
  }

  requestAnimationFrame(() => {
    host.style.opacity = '1';
    host.setAttribute('aria-busy', 'false');
    // Notify body x-data so nav active indicator stays in sync (H3)
    window.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_ROUTE_CHANGED, { detail: { path: normalizedPath } }),
    );
    // Defer non-critical post-render work (scroll, focus, title) to idle time
    // so the paint of the new page isn't blocked.
    if (normalizedPath !== '/auth-callback') {
      ric(
        () => {
          window.scrollTo({ top: 0, behavior: 'auto' });
          try {
            host.focus({ preventScroll: true });
          } catch {
            // preventScroll not supported — silent fallback
          }
          const pageTitle = host
            .querySelector<HTMLElement>('[data-page-title]')
            ?.textContent?.trim();
          if (pageTitle) document.title = `${pageTitle} — Kinetic`;
        },
        { timeout: 300 },
      );
    }
  });
}

export function navigate(path: string, replace = false): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (replace) {
    window.history.replaceState({}, '', target);
  } else if (target !== window.location.pathname) {
    window.history.pushState({}, '', target);
  }
  void render(target);
}

export function initRouter(): void {
  document.addEventListener(
    'click',
    (e) => {
      const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute('href') ?? '';
      if (/^(https?:)?\/\//i.test(href)) return;
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      if (!href.startsWith('/')) return;
      e.preventDefault();
      e.stopPropagation();
      navigate(href);
    },
    { capture: true },
  );

  window.addEventListener('popstate', () => void render(window.location.pathname || '/'));

  let _authReadyReceived = false;

  window.addEventListener(
    STORAGE_KEYS.EVENT_AUTH_READY,
    () => {
      _authReadyReceived = true;
      void render(window.location.pathname || '/');
    },
    { once: true },
  );

  window.addEventListener(STORAGE_KEYS.EVENT_ONBOARDING_COMPLETE, () => {
    _onboardingKnown = true;
    void render(window.location.pathname || '/');
  });

  // FIX race GUEST_MODE : dispatchAuthReady() est appelé SYNCHRONEMENT pendant
  // Alpine.start() (pas d'await dans la branche GUEST_MODE de authStore.init()).
  // initRouter() est appelé via requestAnimationFrame POST-Alpine.start(), donc
  // l'event kinetic:auth-ready peut être dispatché AVANT que le listener { once }
  // ci-dessus soit enregistré → le listener est manqué → la page ne se rend jamais.
  //
  // Solution : setTimeout(0) = macrotask qui s'exécute APRÈS le rAF courant.
  // Si le listener n'a pas été déclenché ET que l'auth est terminée, on
  // rend directement sans attendre un autre event.
  setTimeout(() => {
    if (_authReadyReceived) return; // listener déjà consommé, render en cours
    const appOutlet = document.getElementById('app-outlet');
    // Le skeleton initial dans index.html occupe #app-outlet (donc hasChildNodes()
    // est true) mais N'A PAS d'éléments [x-data] — seules les pages rendues par le
    // router en ont. Tester `[x-data]` distingue fiablement "skeleton seul" de
    // "router a déjà rendu", peu importe que la page ait ses propres animate-pulse.
    if (appOutlet && appOutlet.querySelector('[x-data]')) return; // déjà rendu
    type WindowWithAlpine = Window & { Alpine?: { store?: (name: string) => unknown } };
    const auth = (window as WindowWithAlpine).Alpine?.store?.('auth') as
      | { loading?: boolean }
      | undefined;
    if (!auth || auth.loading === false) {
      void render(window.location.pathname || '/');
    }
  }, 0);
}
