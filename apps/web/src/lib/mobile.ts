import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';
// Import statique : le client est déjà chargé au démarrage (store auth). Un import()
// du point d'entrée du paquet garderait TOUS ses exports dans le lot de démarrage.
import { closeAllLocalDatabases, supabase } from '@kinetic/adapters-web';
import { createDeepLinkGate, firstLaunchUrl, parseDeepLink } from './deep-link';
import { currentHistoryIdx } from './nav-motion';
import { pageBackground } from './palette';
import { notify } from './notify';

// Structural type — avoids SupabaseClient generic-mismatch errors when
// supabase-js adds new class generics (e.g. ClientOptions in 2.105+).
interface SupabaseAuthLike {
  auth: {
    setSession(tokens: { access_token: string; refresh_token: string }): Promise<{
      data: { user?: { id: string } | null; session?: unknown | null };
      error: { message: string } | null;
    }>;
    getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error?: unknown }>;
    exchangeCodeForSession(codeOrUrl: string): Promise<{ error: { message: string } | null }>;
  };
}

const DEBUG_KEY = STORAGE_KEYS.AUTH_DEBUG;

/**
 * Stocke un message de debug dans localStorage.
 *
 * Activé EN PRODUCTION pour diagnostiquer les bugs OAuth APK chez les vrais
 * utilisateurs. Le log ne contient JAMAIS de tokens (URLs sont tronquées 200
 * chars max et les tokens vivent dans le hash après le `#`, donc invisible
 * dans les premiers 200 chars d'une URL Supabase typique). Le log est lisible
 * dans Profil → Diagnostic auth, à effacer après diagnostic.
 */
function debugLog(msg: string): void {
  try {
    const prev = localStorage.getItem(DEBUG_KEY) ?? '';
    const stamp = new Date().toISOString().slice(11, 19);
    localStorage.setItem(DEBUG_KEY, `${prev}\n[${stamp}] ${msg}`.slice(-2000));
  } catch {
    /* ignore */
  }
}

/** Affiche une page de l'application sans recharger (widget, notification). */
function openRoute(route: string): void {
  // kIdx conservé : le sens des transitions (nav-motion.ts) reste juste ensuite.
  if (window.location.pathname !== route) {
    window.history.replaceState({ kIdx: currentHistoryIdx() }, '', route);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Un même lien reçu deux fois de suite (lancement à froid) n'est traité qu'une fois. */
const deepLinkGate = createDeepLinkGate();

/**
 * Lien interne (widget, notification, raccourci) : ouvre la page et lance
 * l'action éventuelle. Faux si ce n'est pas un lien interne (retour OAuth…).
 */
function handleDeepLink(url: string): boolean {
  const link = parseDeepLink(url);
  if (!link) return false;
  if (!deepLinkGate(url)) return true;
  if (!link.action) {
    openRoute(link.route);
    return true;
  }
  const action = link.action;
  void import('./shortcut-actions')
    .then(({ runShortcutAction }) => runShortcutAction(action, openRoute))
    .catch((err) => {
      debugLog(`shortcut ${action}: ${String(err).slice(0, 200)}`);
      openRoute(link.route);
    });
  return true;
}

function sessionMemory(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * initMobile — initialise les plugins Capacitor natifs.
 * Gère aussi le retour OAuth (deep link ou launch URL).
 */
export async function initMobile(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  // Barre d'état assortie au thème (sombre ou clair), y compris quand il change.
  const syncStatusBar = async (): Promise<void> => {
    try {
      const { StatusBar, Style } = await import('@capacitor/status-bar');
      const light =
        typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-mode') === 'light';
      await StatusBar.setStyle({ style: light ? Style.Light : Style.Dark });
      await StatusBar.setBackgroundColor({ color: pageBackground(light ? 'light' : 'dark') });
    } catch {
      /* ignore */
    }
  };
  await syncStatusBar();
  try {
    window.addEventListener(STORAGE_KEYS.EVENT_THEME_CHANGED, () => void syncStatusBar());
  } catch {
    /* ignore */
  }

  void import('./autotest')
    .then(({ runAutotest }) => runAutotest(openRoute))
    .catch((err) => debugLog(`autotest: ${String(err).slice(0, 200)}`));

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch {
    /* ignore */
  }

  try {
    const { App: CapApp } = await import('@capacitor/app');

    // ── Cas 1 : app FERMÉE → lancée via deep link ──────────────────────
    // (appUrlOpen ne se déclenche PAS dans ce cas)
    const launch = await CapApp.getLaunchUrl();
    if (launch?.url) {
      debugLog(`launchUrl: ${launch.url.slice(0, 200)}`);
      if (parseDeepLink(launch.url)) {
        // Après un rechargement de la page, le même lien revient : ne pas rejouer l'action.
        if (firstLaunchUrl(launch.url, sessionMemory())) handleDeepLink(launch.url);
      } else if (launch.url.startsWith('com.lamajoker.kinetic://')) {
        if (supabase) {
          await handleOAuthCallback(supabase, launch.url);
          return;
        } else {
          debugLog('launchUrl: supabase=null !');
        }
      }
    }

    // ── Cas 2 : app en ARRIÈRE-PLAN → deep link reçu ───────────────────
    CapApp.addListener('appUrlOpen', async ({ url }) => {
      debugLog(`appUrlOpen: ${url.slice(0, 200)}`);
      if (handleDeepLink(url)) return;
      if (!url.startsWith('com.lamajoker.kinetic://')) return;
      if (supabase) await handleOAuthCallback(supabase, url);
      else debugLog('appUrlOpen: supabase=null !');
    });

    CapApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack && window.history.length > 1) {
        window.history.back();
      } else {
        CapApp.exitApp();
      }
    });
  } catch (err) {
    debugLog(`initMobile error: ${String(err).slice(0, 200)}`);
  }

  // Appui sur un rappel : ouvrir la page concernée.
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const route = (action.notification.extra as { route?: unknown } | undefined)?.route;
      if (typeof route === 'string' && /^\/[a-z-]*$/.test(route)) openRoute(route);
    });
  } catch {
    /* ignore */
  }
}

/**
 * handleOAuthCallback — extrait le token de l'URL et établit la session.
 * Implicit flow (mobile) : tokens dans le hash → setSession()
 * PKCE flow : ?code= → exchangeCodeForSession()
 * M8 FIX : paramètre supabase correctement typé (était `any`)
 */
export async function handleOAuthCallback(supabase: SupabaseAuthLike, url: string): Promise<void> {
  try {
    debugLog(`handleOAuthCallback start: ${url.slice(0, 150)}`);

    const normalized = url.replace(/^com\.lamajoker\.kinetic:\/\//, 'https://app/');
    const parsed = new URL(normalized);

    // Hash params : #access_token=XXX (implicit flow)
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const accessToken = hashParams.get('access_token') ?? parsed.searchParams.get('access_token');
    const refreshToken =
      hashParams.get('refresh_token') ?? parsed.searchParams.get('refresh_token');

    // Query params : ?code=XXX (PKCE flow)
    const code = parsed.searchParams.get('code');

    // Erreurs Supabase éventuelles : on les notifie à l'utilisateur via le
    // store toast, sinon le retour de Chrome Custom Tabs ferme et on reste
    // sur le dashboard sans aucun feedback (utilisateur pense que ça marche).
    const errorDesc =
      hashParams.get('error_description') ?? parsed.searchParams.get('error_description');
    if (errorDesc) {
      const decoded = decodeURIComponent(errorDesc.replace(/\+/g, ' '));
      debugLog(`OAuth error from provider: ${decoded}`);
      try {
        notify('error', `Connexion refusée : ${decoded}`);
      } catch {
        /* ignore */
      }
    }

    if (accessToken && refreshToken) {
      debugLog(`setSession (tokenLen=${accessToken.length}/${refreshToken.length})`);
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) debugLog(`setSession err: ${error.message}`);
      else debugLog(`setSession OK uid=${data?.user?.id?.slice(0, 8) ?? 'none'}`);

      // Vérification : la session est-elle bien persistée et lisible immédiatement ?
      // Si non, le redirect /  échouera silencieusement (auth store ne trouve rien
      // dans localStorage à la réinitialisation post-reload).
      try {
        const {
          data: { session: verify },
        } = await supabase.auth.getSession();
        debugLog(`verify session: ${verify ? `uid=${verify.user.id.slice(0, 8)}` : 'NULL!'}`);
      } catch (e) {
        debugLog(`verify err: ${String(e).slice(0, 100)}`);
      }
    } else if (code) {
      debugLog(`exchangeCodeForSession`);
      let { error } = await supabase.auth.exchangeCodeForSession(url);
      if (error) {
        debugLog(`exchange(url) err: ${error.message} → retry with code`);
        ({ error } = await supabase.auth.exchangeCodeForSession(code));
      }
      if (error) debugLog(`exchange err final: ${error.message}`);
      else debugLog(`exchange OK`);
    } else {
      debugLog(`no token/code in URL — hash="${parsed.hash.slice(0, 80)}"`);
    }
  } catch (err) {
    debugLog(`callback exception: ${String(err).slice(0, 200)}`);
  } finally {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch {
      /* ignore */
    }

    // BUG FIX (8 mai 2026) : on PRÉFÈRE la navigation SPA au reload complet.
    //   `window.location.href = '/'` recharge toute la page et reset le JS
    //   context. Le nouveau Supabase client doit alors lire localStorage pour
    //   retrouver la session — mais sur Capacitor WebView, le timing entre
    //   setSession() et le flush localStorage n'est PAS garanti. Résultat
    //   observé : reload trop tôt → nouvelle instance Supabase voit pas la
    //   session → user vu comme déconnecté → écran login réapparaît.
    //
    //   Avec SPA nav, on garde le client Supabase en mémoire (avec session
    //   définie via setSession), le auth store reçoit l'event SIGNED_IN
    //   d'onAuthStateChange et met à jour this.user → dashboard se rend.
    debugLog(`SPA-nav to /`);
    try {
      window.history.replaceState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
      // Notifier les stores Alpine pour reload (les deps doivent passer en
      // mode HybridStorage maintenant que l'utilisateur est authentifié).
      window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_AUTH_CHANGED));
    } catch (e) {
      debugLog(`SPA-nav err, fallback hard reload: ${String(e).slice(0, 80)}`);
      // Bases IndexedDB fermées avant la navigation pleine page (sync.md § 4.11 bis).
      await closeAllLocalDatabases();
      window.location.href = '/';
    }
  }
}

/** Récupère et efface le log de debug (à appeler depuis le profil) */
export function readAuthDebugLog(): string {
  try {
    const log = localStorage.getItem(DEBUG_KEY) ?? '';
    return log.trim();
  } catch {
    return '';
  }
}

export function clearAuthDebugLog(): void {
  try {
    localStorage.removeItem(DEBUG_KEY);
  } catch {
    /* ignore — localStorage indisponible */
  }
}
