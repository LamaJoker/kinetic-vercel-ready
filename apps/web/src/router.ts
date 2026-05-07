/**
 * SPA Router - History API + pages bundled by Vite.
 * FIX #2: Route /auth-callback alignée avec callbackUrl() dans auth.ts
 * FIX #3: Hash URL préservé avant navigation pour les magic links
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
  | '/auth-callback'   // ← FIX #2 : était '/auth/callback' — aligné avec callbackUrl()
  | '/bodyweight'
  | '/progression'
  | '/mensurations';

const ROUTES: Record<RouteKey, string> = {
  '/':              './pages/dashboard.html',
  '/onboarding':    './pages/onboarding.html',
  '/seances':       './pages/seances.html',
  '/vitalite':      './pages/vitalite.html',
  '/nutrition':     './pages/nutrition.html',
  '/program':       './pages/program.html',
  '/login':         './pages/login.html',
  '/profile':       './pages/profile.html',
  '/auth-callback': './pages/auth-callback.html', // ← FIX #2
  '/bodyweight':    './pages/bodyweight.html',
  '/progression':   './pages/progression.html',
  '/mensurations':  './pages/mensurations.html',
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

  host.querySelectorAll<HTMLElement>('[x-data]').forEach((el) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (el as any)._x_dataStack?.[0];
    if (data && typeof data.destroy === 'function') {
      try { data.destroy(); }
      catch (err) { console.warn('[router] component destroy failed:', err); }
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
    // FIX #3 : Ne pas remonter en haut de page sur /auth-callback
    // (évite un éventuel flash avant la redirection)
    if (normalizedPath !== '/auth-callback') {
      window.scrollTo({ top: 0, behavior: 'auto' });
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

  let _authReadyReceived = false;

  window.addEventListener('kinetic:auth-ready', () => {
    _authReadyReceived = true;
    void render(window.location.pathname || '/');
  }, { once: true });

  window.addEventListener('kinetic:onboarding-complete', () => {
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
    if (appOutlet && appOutlet.hasChildNodes()) return; // déjà rendu
    const auth = (window as any).Alpine?.store?.('auth') as { loading?: boolean } | undefined;
    if (!auth || auth.loading === false) {
      void render(window.location.pathname || '/');
    }
  }, 0);
}
