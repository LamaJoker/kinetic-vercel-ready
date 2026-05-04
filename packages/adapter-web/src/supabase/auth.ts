import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

const SUPABASE_URL      = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

// Vérifier que les variables ne sont pas des placeholders
const isValidUrl = typeof SUPABASE_URL === 'string'
  && SUPABASE_URL.startsWith('https://')
  && SUPABASE_URL.includes('.supabase.co')
  && !SUPABASE_URL.includes('xxxxxxxxxxxxxxxxxxxx');

// FIX #4 : Validation élargie — accepte tous les formats Supabase connus
const _knownKeyPrefixes = ['eyJ', 'sb_publishable_', 'sb_anon_', 'sbp_'];
const isValidKey = typeof SUPABASE_ANON_KEY === 'string'
  && SUPABASE_ANON_KEY.length > 20
  && _knownKeyPrefixes.some(p => SUPABASE_ANON_KEY!.startsWith(p));

// Log explicite si le format est inconnu (nouveau format Supabase ?)
if (
  typeof SUPABASE_ANON_KEY === 'string'
  && SUPABASE_ANON_KEY.length > 20
  && !isValidKey
) {
  console.warn(
    '[Supabase] VITE_SUPABASE_ANON_KEY has an unrecognized format. ' +
    `Starts with: "${SUPABASE_ANON_KEY.slice(0, 15)}...". ` +
    'Known prefixes: eyJ (JWT), sb_publishable_, sb_anon_, sbp_. ' +
    'The Supabase client will NOT be initialized. ' +
    'Update the isValidKey check in adapter-web/src/supabase/auth.ts if Supabase changed their key format.'
  );
}

/** Détecte Capacitor (APK Android / iOS) */
const isCapacitor = typeof window !== 'undefined'
  && !!(window as unknown as Record<string, unknown>)['Capacitor'];

/**
 * URL publique canonique de l'app (configurée via env var).
 * Évite que `window.location.origin` capture une URL Vercel preview/branch
 * (ex: kinetic-vercel-ready-eckiemzif-…vercel.app) au lieu de l'alias prod.
 * Si non définie → fallback sur l'origin courante (dev/local).
 */
const PUBLIC_SITE_URL = (import.meta.env['VITE_PUBLIC_SITE_URL'] as string | undefined)?.replace(/\/+$/, '');

/** URL de callback selon l'environnement (exportée pour diagnostic) */
export function callbackUrl(): string {
  // Sur mobile Capacitor : deep link via le scheme de l'app
  if (isCapacitor) return 'com.lamajoker.kinetic://auth-callback';
  // Sur web : URL publique canonique si configurée, sinon origin courante
  const base = PUBLIC_SITE_URL ?? window.location.origin;
  return `${base}/auth-callback`;
}

/**
 * Client Supabase singleton.
 * null si les variables d'env sont absentes ou invalides (mode guest).
 */
// Sur Capacitor mobile : flow implicit (tokens directs dans l'URL hash, pas de PKCE verifier).
// Le verifier PKCE peut être perdu entre le call signInWithOtp et le retour du deep link
// si le WebView est rechargé. Implicit est plus fiable pour le mobile.
const flowType: 'pkce' | 'implicit' = isCapacitor ? 'implicit' : 'pkce';

export const supabase = (isValidUrl && isValidKey && SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession:     true,
        autoRefreshToken:   true,
        detectSessionInUrl: true,
        storageKey:         'kinetic-auth',
        flowType,
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
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;
    return {
      id:         user.id,
      email:      user.email ?? null,
      avatar_url: user.user_metadata['avatar_url'] as string | null,
      full_name:  user.user_metadata['full_name']  as string | null,
    };
  } catch {
    return null;
  }
}

export async function signInWithEmail(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl() },
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
      redirectTo:  callbackUrl(),
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
        const { data: { session } } = await supabase!.auth.getSession();
        if (session) {
          window.location.href = '/';
        }
      } catch { /* ignore */ }
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
