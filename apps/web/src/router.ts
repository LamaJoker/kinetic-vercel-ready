/**
 * SPA Router - History API + pages bundled by Vite.
 *
 * Pages are imported as raw strings via:
 * import.meta.glob('./pages/*.html', { query: '?raw', eager: true })
 * This means: no runtime fetch for HTML, everything is in the JS bundle.
 */
import Alpine from 'alpinejs';
import { getDeps } from './deps';

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
  | '/auth/callback';

const ROUTES: Record<RouteKey, string> = {
  '/':              './pages/dashboard.html',
  '/onboarding':    './pages/onboarding.html',
  '/seances':       './pages/seances.html',
  '/vitalite':      './pages/vitalite.html',
  '/nutrition':     './pages/nutrition.html',
  '/program':       './pages/program.html',
  '/login':         './pages/login.html',
  '/profile':       './pages/profile.html',
  '/auth/callback': './pages/auth-callback.html',
};

const PROTECTED: readonly RouteKey[] = ['/', '/seances', '/vitalite', '/nutrition', '/program', '/profile'];
const ONBOARDING_EXEMPT: readonly RouteKey[] = ['/onboarding', '/login', '/auth/callback'];

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
      <p class="text-gray-500 text-sm mb-4">Cette route n'existe pas.</p>
      <a href="/" class="text-kinetic-purple underline text-sm">Retour au dashboard</a>
    </div>
  </div>`;

function resolveHtml(path: string): string {
  const file = ROUTES[path as RouteKey];
  if (!file) return NOT_FOUND_HTML;
  return PAGE_MODULES[file] ?? NOT_FOUND_HTML;
}

function isAuthenticated(): boolean {
  const auth = Alpine.store('auth') as { isAuthenticated?: boolean } | undefined;
  return auth?.isAuthenticated === true;
}

function authRequiredFor(path: string): boolean {
  return PROTECTED.includes(path as RouteKey);
}

let _onboardingKnown: boolean | null = null;
async function hasCompletedOnboarding(): Promise<boolean> {
  if (_onboardingKnown !== null) return _onboardingKnown;
  try {
    const deps = await getDeps();
    const profile = await deps.storage.get('kinetic:userProfile');
    _onboardingKnown = Boolean(profile);
    return _onboardingKnown;
  } catch {
    _onboardingKnown = false;
    return false;
  }
}

async function render(path: string): Promise<void> {
  // Force onboarding before accessing the app (goal + profile).
  if (!ONBOARDING_EXEMPT.includes(path as RouteKey)) {
    const ok = await hasCompletedOnboarding();
    if (!ok) {
      navigate('/onboarding', true);
      return;
    }
  }

  // If Supabase is configured, protected routes require auth. In guest mode, auth store
  // will mark the user as authenticated to avoid blocking.
  const auth = Alpine.store('auth') as { loading?: boolean } | undefined;
  if (auth && !auth.loading && authRequiredFor(path) && !isAuthenticated()) {
    const hasSupabase =
      Boolean(import.meta.env['VITE_SUPABASE_URL']) &&
      Boolean(import.meta.env['VITE_SUPABASE_ANON_KEY']);
    if (hasSupabase) {
      navigate('/login', true);
      return;
    }
  }

  const host = outlet();
  host.style.opacity = '0.5';
  host.style.transition = 'opacity 120ms ease-out';
  host.innerHTML = resolveHtml(path);

  Alpine.initTree(host);

  requestAnimationFrame(() => {
    host.style.opacity = '1';
    window.scrollTo({ top: 0, behavior: 'auto' });
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
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return;

    const href = link.getAttribute('href') ?? '';
    const isExternal = /^(https?:)?\/\//i.test(href) || link.target === '_blank';
    const isHashOnly = href.startsWith('#');
    const isMail = href.startsWith('mailto:') || href.startsWith('tel:');

    if (isExternal || isHashOnly || isMail) return;
    if (!href.startsWith('/')) return;

    e.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', () => {
    void render(window.location.pathname || '/');
  });

  window.addEventListener('kinetic:auth-ready', () => {
    void render(window.location.pathname || '/');
  });

  window.addEventListener('kinetic:onboarding-complete', () => {
    _onboardingKnown = true;
    void render(window.location.pathname || '/');
  });

  void render(window.location.pathname || '/');
}