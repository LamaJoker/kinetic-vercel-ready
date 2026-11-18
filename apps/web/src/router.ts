/**
 * SPA Router - History API + pages bundled by Vite.
 * FIX #2: Route /auth-callback alignée avec callbackUrl() dans auth.ts
 * FIX #3: Hash URL préservé avant navigation pour les magic links
 */
import Alpine from 'alpinejs';
import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from './deps';
import { ric } from './lib/performance';
import { loadPageComponents } from './page-components';
import {
  type NavDirection,
  navDirection,
  currentHistoryIdx,
  setHistoryIdx,
  readHistoryIdx,
  takeForcedDirection,
  prefersReducedMotion,
} from './lib/nav-motion';

/**
 * Templates HTML chargés à la demande : au build, chacun devient un fichier
 * statique (static/assets/<page>-<hash>.txt, hors budget JS) téléchargé au
 * premier affichage ; le JS de la page (page-components.ts) arrive en parallèle.
 * `prefetchPages()` précharge ensuite gabarits et composants en tâche de fond pour
 * que le service worker les mette en cache → toutes les pages restent
 * disponibles hors-ligne.
 */
const PAGE_LOADERS = import.meta.glob('./pages/*.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string | (() => Promise<string>)>>;

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
  | '/achievements'
  | '/photos'
  | '/programs'
  | '/glossaire'
  | '/modele'
  | '/exercices'
  | '/legal/cgu'
  | '/legal/confidentialite';

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
  '/photos': './pages/photos.html',
  '/programs': './pages/programs.html',
  '/glossaire': './pages/glossaire.html',
  '/modele': './pages/template-editor.html',
  '/exercices': './pages/template-editor.html',
  '/legal/cgu': './pages/legal-cgu.html',
  '/legal/confidentialite': './pages/legal-confidentialite.html',
};

const ONBOARDING_EXEMPT: readonly RouteKey[] = [
  '/onboarding',
  '/login',
  '/auth-callback',
  '/legal/cgu',
  '/legal/confidentialite',
];

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

const LOAD_ERROR_HTML = `
  <div class="min-h-screen flex items-center justify-center p-8 text-center">
    <div>
      <p class="text-gray-300 font-medium mb-2">Impossible de charger cette page.</p>
      <p class="text-gray-500 text-sm mb-4">Vérifie ta connexion puis réessaie.</p>
      <a href="/" class="text-kinetic-purple underline text-sm">Retour au dashboard</a>
    </div>
  </div>`;

/** Enregistre un composant de page chargé à la demande (page-components.ts). */
function registerComponent(name: string, factory: (...args: never[]) => unknown): void {
  Alpine.data(name, factory as never);
}

/**
 * Gabarit d'une page : chaîne en dev ; au build, fonction qui le télécharge
 * (fichier statique, cf. compactPageHtml dans vite.config.ts).
 */
async function readTemplate(template: string | (() => Promise<string>)): Promise<string> {
  return typeof template === 'function' ? template() : template;
}

async function resolveHtml(path: string): Promise<string> {
  const file = ROUTES[path as RouteKey];
  const load = file ? PAGE_LOADERS[file] : undefined;
  if (!file || !load) return NOT_FOUND_HTML;
  try {
    // Gabarit et composants Alpine de la page en parallèle : aucun aller-retour de plus.
    const [html] = await Promise.all([
      load().then(readTemplate),
      loadPageComponents(file, registerComponent),
    ]);
    return html;
  } catch (err) {
    console.error('[router] page template load failed:', path, err);
    return LOAD_ERROR_HTML;
  }
}

let prefetched = false;

/** Précharge tous les templates pendant un temps mort (cache SW → offline complet). */
export function prefetchPages(): void {
  if (prefetched) return;
  prefetched = true;
  ric(
    () => {
      for (const [file, load] of Object.entries(PAGE_LOADERS)) {
        void load()
          .then(readTemplate)
          .catch(() => undefined);
        void loadPageComponents(file, registerComponent).catch(() => undefined);
      }
    },
    { timeout: 10_000 },
  );
}

/** Incrémenté à chaque navigation : un rendu lent ne peut pas écraser un rendu plus récent. */
let renderSeq = 0;

let _onboardingKnown: boolean | null = null;

async function hasCompletedOnboarding(): Promise<boolean> {
  // E2E test override: allow tests to skip the IDB onboarding check without
  // having to write USER_PROFILE to IDB (which causes a persistent IDB
  // connection hang on mobile-safari/WebKit CI when set from a test context).
  // Set via page.addInitScript() before app code runs.
  // Compilé uniquement dans les builds E2E (VITE_E2E=true) : absent du bundle de production.
  if (
    import.meta.env.VITE_E2E === 'true' &&
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

/** Chemin de la page affichée (sens des transitions). */
let renderedPath: string | null = null;
/** Jeton de la View Transition en cours (on ne nettoie que la sienne). */
let navToken = 0;

/** View Transitions disponibles (WKWebView iOS 18+, WebView Chrome 111+) et souhaitées. */
function canViewTransition(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof (document as Document & { startViewTransition?: unknown }).startViewTransition ===
      'function' &&
    !prefersReducedMotion()
  );
}

async function render(path: string, direction: NavDirection = 'none'): Promise<void> {
  const seq = ++renderSeq;
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
  host.setAttribute('aria-busy', 'true');

  const html = await resolveHtml(normalizedPath);
  if (seq !== renderSeq) return; // une navigation plus récente a pris la main

  const useViewTransition = direction !== 'none' && renderedPath !== null && canViewTransition();
  renderedPath = normalizedPath;

  const swap = (): void => {
    // Rendu plus récent arrivé pendant la capture de la View Transition : on le laisse faire.
    if (seq !== renderSeq) return;
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

    host.innerHTML = html;
    // Reste éventuel du geste « retour » (native-gestures.ts) : la page sortante
    // était décalée sous le doigt ; la nouvelle doit repartir sans transformation.
    host.style.removeProperty('transform');
    host.style.removeProperty('transition');
    host.classList.remove('k-route-in', 'k-swiping-back', 'k-ptr-settling');
    if (useViewTransition) {
      // La View Transition anime l'écran entier : nouvel écran capturé en haut de page.
      window.scrollTo(0, 0);
    } else {
      // Entrée de page en cascade (styles.css → #app-outlet.k-route-in). On remet la
      // classe en forçant un reflow pour rejouer l'animation à chaque page.
      void host.offsetWidth;
      host.classList.add('k-route-in');
    }

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
  };

  if (useViewTransition) {
    // Transition façon iOS (nav-motion.ts + styles/native-feel.css). Le sens est posé
    // sur <html data-k-nav> le temps de l'animation ; seule la dernière l'efface.
    const root = document.documentElement;
    const token = ++navToken;
    root.dataset.kNav = direction;
    try {
      const vt = (
        document as Document & {
          startViewTransition(cb: () => void): {
            updateCallbackDone: Promise<void>;
            ready: Promise<void>;
            finished: Promise<void>;
          };
        }
      ).startViewTransition(swap);
      // Transition sautée (onglet masqué, taille de fenêtre changée…) : `ready` est
      // rejetée ; ce n'est pas une erreur, le rendu a bien eu lieu.
      vt.ready.catch(() => undefined);
      void vt.finished
        .catch(() => undefined)
        .then(() => {
          if (token === navToken) delete root.dataset.kNav;
        });
      await vt.updateCallbackDone.catch(() => undefined);
    } catch {
      delete root.dataset.kNav;
      swap();
    }
  } else {
    swap();
  }
  if (seq !== renderSeq) return;

  requestAnimationFrame(() => {
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

/**
 * Vrai si le routeur a déjà rendu une page dans #app-outlet. Le squelette
 * initial d'index.html occupe l'outlet mais n'a pas d'élément [x-data] :
 * seules les pages rendues par le routeur en ont.
 */
function hasRenderedPage(): boolean {
  return !!document.getElementById('app-outlet')?.querySelector('[x-data]');
}

export function navigate(path: string, replace = false): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  const from = renderedPath ?? window.location.pathname;
  const idx = currentHistoryIdx();
  let kind: 'push' | 'replace' = 'replace';
  if (replace) {
    window.history.replaceState({ kIdx: idx }, '', target);
  } else if (target !== window.location.pathname) {
    window.history.pushState({ kIdx: idx + 1 }, '', target);
    setHistoryIdx(idx + 1);
    kind = 'push';
  }
  void render(target, navDirection(from, target, kind));
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

  // Index d'historique (sens avant / arrière des popstate, geste « retour »).
  // L'entrée de lancement n'a pas de kIdx : on le pose (sans toucher à l'URL ni au
  // hash OAuth), sinon le retour vers elle serait un simple fondu au lieu d'un « back ».
  const initialIdx = readHistoryIdx(window.history.state);
  setHistoryIdx(initialIdx ?? 0);
  if (initialIdx === null) {
    try {
      const prev: unknown = window.history.state;
      const base = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
      window.history.replaceState({ ...base, kIdx: 0 }, '');
    } catch {
      /* état d'historique non clonable : sens par défaut (fondu) */
    }
  }
  window.addEventListener('popstate', (e) => {
    const to = window.location.pathname || '/';
    const fromIdx = currentHistoryIdx();
    const toIdx = readHistoryIdx(e.state);
    if (toIdx !== null) setHistoryIdx(toIdx);
    const dir =
      takeForcedDirection() ??
      navDirection(
        renderedPath ?? to,
        to,
        renderedPath === null ? 'initial' : 'pop',
        fromIdx,
        toIdx,
      );
    void render(to, dir);
  });

  // Gestes natifs (retour par le bord, tirer pour rafraîchir), chargés à part.
  void import('./lib/native-gestures')
    .then(({ initNativeGestures }) => initNativeGestures())
    .catch(() => undefined);

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('load', () => prefetchPages(), { once: true });
    if (document.readyState === 'complete') prefetchPages();
  }

  let _authReadyReceived = false;

  window.addEventListener(
    STORAGE_KEYS.EVENT_AUTH_READY,
    () => {
      _authReadyReceived = true;
      // Rendu initial uniquement. En mode invité, auth-ready peut partir avant
      // que cet écouteur soit branché : le rendu de secours ci-dessous a alors
      // déjà affiché la page, et l'écouteur restait armé. Un auth-ready ultérieur
      // re-rendait la page par-dessus elle-même, recréant le composant en plein
      // travail (ex. Séances perdait la séance lancée depuis l'accueil).
      if (hasRenderedPage()) return;
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
    if (hasRenderedPage()) return; // déjà rendu
    type WindowWithAlpine = Window & { Alpine?: { store?: (name: string) => unknown } };
    const auth = (window as WindowWithAlpine).Alpine?.store?.('auth') as
      | { loading?: boolean }
      | undefined;
    if (!auth || auth.loading === false) {
      void render(window.location.pathname || '/');
    }
  }, 0);
}
