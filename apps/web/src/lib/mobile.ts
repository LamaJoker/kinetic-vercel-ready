import { Capacitor } from '@capacitor/core';
import type { SupabaseClient } from '@supabase/supabase-js';

const DEBUG_KEY = 'kinetic:auth-debug';

/**
 * Stocke un message de debug dans localStorage.
 * H1/L5 FIX : uniquement en mode DEV — aucun log en production
 * pour éviter la fuite d'informations OAuth sur appareils partagés.
 */
function debugLog(msg: string): void {
  if (!import.meta.env.DEV) return;
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

    // Erreurs Supabase éventuelles
    const errorDesc = hashParams.get('error_description') ?? parsed.searchParams.get('error_description');
    if (errorDesc) {
      debugLog(`OAuth error from provider: ${errorDesc}`);
    }

    if (accessToken && refreshToken) {
      debugLog(`setSession with tokens`);
      const { error } = await supabase.auth.setSession({
        access_token:  accessToken,
        refresh_token: refreshToken,
      });
      if (error) debugLog(`setSession err: ${error.message}`);
      else debugLog(`setSession OK`);
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
      debugLog(`no token/code in URL`);
    }

  } catch (err) {
    debugLog(`callback exception: ${String(err).slice(0, 200)}`);
  } finally {
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch { /* ignore */ }

    window.location.href = '/';
  }
}

/** Récupère et efface le log de debug (à appeler depuis le profil) */
export function readAuthDebugLog(): string {
  const log = localStorage.getItem(DEBUG_KEY) ?? '';
  return log.trim();
}

export function clearAuthDebugLog(): void {
  localStorage.removeItem(DEBUG_KEY);
}
