import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

const SUPABASE_URL = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

// Vérifier que les variables ne sont pas des placeholders
const isValidUrl =
  typeof SUPABASE_URL === 'string' &&
  SUPABASE_URL.startsWith('https://') &&
  SUPABASE_URL.includes('.supabase.co') &&
  !SUPABASE_URL.includes('xxxxxxxxxxxxxxxxxxxx');

// FIX #4 : Validation élargie — accepte tous les formats Supabase connus
const _knownKeyPrefixes = ['eyJ', 'sb_publishable_', 'sb_anon_', 'sbp_'];
const isValidKey =
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.length > 20 &&
  _knownKeyPrefixes.some((p) => SUPABASE_ANON_KEY!.startsWith(p));

// Log explicite si le format est inconnu (nouveau format Supabase ?)
if (typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.length > 20 && !isValidKey) {
  console.warn(
    '[Supabase] VITE_SUPABASE_ANON_KEY has an unrecognized format. ' +
      `Starts with: "${SUPABASE_ANON_KEY.slice(0, 15)}...". ` +
      'Known prefixes: eyJ (JWT), sb_publishable_, sb_anon_, sbp_. ' +
      'The Supabase client will NOT be initialized. ' +
      'Update the isValidKey check in adapter-web/src/supabase/auth.ts if Supabase changed their key format.',
  );
}

/** Détecte Capacitor (APK Android / iOS) */
const isCapacitor =
  typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)['Capacitor'];

/**
 * URL publique canonique de l'app (configurée via env var).
 * Évite que `window.location.origin` capture une URL Vercel preview/branch
 * (ex: kinetic-vercel-ready-eckiemzif-…vercel.app) au lieu de l'alias prod.
 * Si non définie → fallback sur l'origin courante (dev/local).
 */
const PUBLIC_SITE_URL = (import.meta.env['VITE_PUBLIC_SITE_URL'] as string | undefined)?.replace(
  /\/+$/,
  '',
);

/**
 * URL de callback selon l'environnement (exportée pour diagnostic).
 *
 * Sur Capacitor (Android/iOS) : on utilise l'URL HTTPS /auth-callback,
 * PAS le deep link custom scheme directement. Pourquoi :
 *   Chrome Custom Tabs (utilisé par signInWithOAuth) ne peut pas naviguer
 *   vers un custom scheme (com.lamajoker.kinetic://…) après le redirect OAuth
 *   → Google/Supabase redirige dessus → Chrome affiche about:blank.
 *
 * Solution : Supabase redirige vers /auth-callback (HTTPS, ouvrable dans
 * Chrome Custom Tabs). Cette page extrait les tokens et fait ensuite
 *   window.location.href = 'com.lamajoker.kinetic://auth-callback#tokens…'
 * pour hand-off vers l'APK via l'Intent filter Android.
 *
 * BUG FIX (mai 2026) : on AJOUTE `?from=apk` quand on lance le flow depuis
 * l'APK. La page /auth-callback (qui tourne sur Vercel dans Chrome Custom Tabs)
 * ne peut PAS détecter via `window.Capacitor` qu'elle a été ouverte depuis
 * l'APK — elle est dans le navigateur Chrome standalone. Le marqueur dans
 * l'URL est le seul moyen fiable de savoir qu'il faut faire le hand-off.
 */
export function callbackUrl(opts: { capacitor?: boolean } = {}): string {
  // CRITIQUE : sur web on DOIT utiliser window.location.origin (pas PUBLIC_SITE_URL),
  // sinon le verifier PKCE est stocké sur le domaine A, l'OAuth redirige vers le
  // domaine B, et le localStorage cross-origin n'est pas partagé → "PKCE code
  // verifier not found in storage". PUBLIC_SITE_URL n'est utilisé QUE pour Capacitor
  // (APK Android), où window.location est `https://localhost` (inutilisable).
  const base = opts.capacitor
    ? (PUBLIC_SITE_URL ?? window.location.origin)
    : window.location.origin;
  const url = `${base}/auth-callback`;
  return opts.capacitor ? `${url}?from=apk` : url;
}

/**
 * Client Supabase singleton.
 * null si les variables d'env sont absentes ou invalides (mode guest).
 */
// PKCE partout — y compris sur Capacitor.
// Pourquoi : Google a déprécié l'implicit flow ; Supabase retourne toujours ?code=
// (même si on demande implicit). Le verifier PKCE est généré par signInWithOAuth()
// dans la WebView APK et stocké dans son localStorage (clé "kinetic-auth-code-verifier").
// Chrome Custom Tabs n'y a pas accès — c'est pourquoi auth-callback.page.ts passe
// le ?code= à l'APK via deep link (com.lamajoker.kinetic://auth-callback?code=...) et
// c'est la WebView APK qui appelle exchangeCodeForSession() avec son propre verifier.
//
// detectSessionInUrl: false — on parse l'URL manuellement dans auth-callback.page.ts.
// Évite la double-tentative d'échange (Supabase auto + notre code) qui produirait
// "PKCE code verifier not found" dans Chrome Custom Tabs ou "code already used" dans APK.

export const supabase =
  isValidUrl && isValidKey && SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false, // géré manuellement dans auth-callback.page.ts
          storageKey: 'kinetic-auth',
          flowType: 'pkce', // toujours pkce ; verifier stocké dans la WebView APK
        },
      })
    : null;

export type AuthUser = {
  id: string;
  email: string | null;
  avatar_url: string | null;
  full_name: string | null;
};

export async function getAuthUser(): Promise<AuthUser | null> {
  if (!supabase) return null;
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) return null;
    return {
      id: user.id,
      email: user.email ?? null,
      avatar_url: user.user_metadata['avatar_url'] as string | null,
      full_name: user.user_metadata['full_name'] as string | null,
    };
  } catch {
    return null;
  }
}

export async function signInWithEmail(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl({ capacitor: isCapacitor }) },
  });
  if (error) throw new Error(error.message);
}

/**
 * OAuth avec support Capacitor.
 * Sur mobile : ouvre un vrai navigateur (Chrome Custom Tabs) via @capacitor/browser
 * pour contourner le blocage Google/GitHub dans les WebViews.
 */
async function signInWithOAuth(provider: 'google' | 'github'): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: callbackUrl({ capacitor: isCapacitor }),
      skipBrowserRedirect: isCapacitor, // on gère la redirection nous-mêmes sur mobile
    },
  });

  if (error) throw new Error(error.message);

  // Sur Capacitor, ouvrir l'URL OAuth dans un vrai navigateur (Chrome Custom Tabs)
  // windowName omis intentionnellement — '_self' forcerait la WebView au lieu du Custom Tab
  if (isCapacitor && data.url) {
    const { Browser } = await import('@capacitor/browser');

    // H2 FIX: stocker le handle pour supprimer le listener après le premier appel
    // (évite l'accumulation de listeners sur chaque tentative OAuth)
    const listenerHandle = await Browser.addListener('browserFinished', async () => {
      await listenerHandle.remove();
      try {
        const {
          data: { session },
        } = await supabase!.auth.getSession();
        if (session) {
          window.location.href = '/';
        }
      } catch {
        /* ignore */
      }
    });

    await Browser.open({ url: data.url });
  }
}

export async function signInWithGitHub(): Promise<void> {
  return signInWithOAuth('github');
}

export async function signInWithGoogle(): Promise<void> {
  return signInWithOAuth('google');
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}
