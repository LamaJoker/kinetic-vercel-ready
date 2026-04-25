/**
 * SPA Router - History API + pages bundled by Vite.
 * FIXES:
 * 1. render() ne bloque plus la navigation
 * 2. Route /bodyweight ajoutée
 * 3. capture:true sur les clics pour intercepter avant Alpine
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
  | '/auth/callback'
  | '/bodyweight';

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
  '/bodyweight':    './pages/bodyweight.html',
};

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
  if (_onboardingKnown !== null) return _onboardingKnown;
  try {
    const deps = await getDeps();
    const profile = await deps.storage.get('kinetic:userProfile');
    _onboardingKnown = Boolean(profile);
    return _onboardingKnown;
  } catch {
    _onboardingKnown = true;
    return true;
  }
}

async function render(path: string): Promise<void> {
  const normalizedPath = (path || '/').split('?')[0]!;

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
  host.innerHTML = resolveHtml(normalizedPath);

  // Les <script> injectés via innerHTML ne s'exécutent pas (spec HTML5).
  // On les recrée en tant que vrais éléments DOM pour définir les fonctions globales
  // (profilePage, bodyweightPage, etc.) avant qu'Alpine.initTree les évalue.
  host.querySelectorAll<HTMLScriptElement>('script').forEach((old) => {
    const s = document.createElement('script');
    s.textContent = old.textContent ?? '';
    document.head.appendChild(s);
    document.head.removeChild(s);
  });

  try {
    Alpine.initTree(host);
  } catch (e) {
    console.warn('[router] Alpine.initTree failed:', e);
  }

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
  // capture: true pour intercepter avant Alpine
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute('href') ?? '';
    if (/^(https?:)?\/\//i.test(href)) return;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (!href.startsWith('/')) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(href);
  }, { capture: true });

  window.addEventListener('popstate', () => void render(window.location.pathname || '/'));

  window.addEventListener('kinetic:auth-ready', () => {
    void render(window.location.pathname || '/');
  }, { once: true });

  window.addEventListener('kinetic:onboarding-complete', () => {
    _onboardingKnown = true;
    void render(window.location.pathname || '/');
  });

  // Fallback si auth-ready tarde (ex: Supabase lent)
  setTimeout(() => {
    const host = outlet();
    if (host.querySelector('.animate-pulse')) {
      void render(window.location.pathname || '/');
    }
  }, 1500);
}
