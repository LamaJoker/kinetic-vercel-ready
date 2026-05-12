import { Capacitor } from '@capacitor/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { STORAGE_KEYS } from '@kinetic/core';

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
  } catch { /* ignore */ }
}

/**
 * initMobile — initialise les plugins Capacitor natifs.
 * Gère aussi le retour OAuth (deep link ou launch URL).
 */
export async function initMobile(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0b0f1a' });
  } catch { /* ignore */ }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide({ fadeOutDuration: 300 });
  } catch { /* ignore */ }

  try {
    const { App: CapApp } = await import('@capacitor/app');

    // ── Cas 1 : app FERMÉE → lancée via deep link ──────────────────────
    // (appUrlOpen ne se déclenche PAS dans ce cas)
    const launch = await CapApp.getLaunchUrl();
    if (launch?.url) {
      debugLog(`launchUrl: ${launch.url.slice(0, 200)}`);
      if (launch.url.startsWith('com.lamajoker.kinetic://')) {
        const { supabase } = await import('@kinetic/adapters-web');
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
      if (!url.startsWith('com.lamajoker.kinetic://')) return;
      const { supabase } = await import('@kinetic/adapters-web');
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
}

/**
 * handleOAuthCallback — extrait le token de l'URL et établit la session.
 * Implicit flow (mobile) : tokens dans le hash → setSession()
 * PKCE flow : ?code= → exchangeCodeForSession()
 * M8 FIX : paramètre supabase correctement typé (était `any`)
 */
export async function handleOAuthCallback(
  supabase: SupabaseClient,
  url: string,
): Promise<void> {
  try {
    debugLog(`handleOAuthCallback start: ${url.slice(0, 150)}`);

    const normalized = url.replace(/^com\.lamajoker\.kinetic:\/\//, 'https://app/');
    const parsed = new URL(normalized);

    // Hash params : #access_token=XXX (implicit flow)
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const accessToken  = hashParams.get('access_token')  ?? parsed.searchParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token') ?? parsed.searchParams.get('refresh_token');

    // Query params : ?code=XXX (PKCE flow)
    const code = parsed.searchParams.get('code');

    // Erreurs Supabase éventuelles : on les notifie à l'utilisateur via le
    // store toast, sinon le retour de Chrome Custom Tabs ferme et on reste
    // sur le dashboard sans aucun feedback (utilisateur pense que ça marche).
    const errorDesc = hashParams.get('error_description') ?? parsed.searchParams.get('error_description');
    if (errorDesc) {
      const decoded = decodeURIComponent(errorDesc.replace(/\+/g, ' '));
      debugLog(`OAuth error from provider: ${decoded}`);
      try {
        window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
          detail: { kind: 'error', message: `Connexion refusée : ${decoded}` },
        }));
      } catch { /* ignore */ }
    }

    if (accessToken && refreshToken) {
      debugLog(`setSession (tokenLen=${accessToken.length}/${refreshToken.length})`);
      const { data, error } = await supabase.auth.setSession({
        access_token:  accessToken,
        refresh_token: refreshToken,
      });
      if (error) debugLog(`setSession err: ${error.message}`);
      else debugLog(`setSession OK uid=${data?.user?.id?.slice(0,8) ?? 'none'}`);

      // Vérification : la session est-elle bien persistée et lisible immédiatement ?
      // Si non, le redirect /  échouera silencieusement (auth store ne trouve rien
      // dans localStorage à la réinitialisation post-reload).
      try {
        const { data: { session: verify } } = await supabase.auth.getSession();
        debugLog(`verify session: ${verify ? `uid=${verify.user.id.slice(0,8)}` : 'NULL!'}`);
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
      debugLog(`no token/code in URL — hash="${parsed.hash.slice(0,80)}"`);
    }

  } catch (err) {
    debugLog(`callback exception: ${String(err).slice(0, 200)}`);
  } finally {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch { /* ignore */ }

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
      debugLog(`SPA-nav err, fallback hard reload: ${String(e).slice(0,80)}`);
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
