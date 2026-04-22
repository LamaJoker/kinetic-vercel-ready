import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

const SUPABASE_URL      = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

/**
 * Client Supabase singleton — partagé dans toute l'app.
 * Si les variables d'env sont absentes, retourne null (mode guest).
 */
export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession:     true,
        autoRefreshToken:   true,
        detectSessionInUrl: true,
        storageKey:         'kinetic-auth',
      },
    })
  : null;

export type AuthUser = {
  id: string;
  email: string | null;
  avatar_url: string | null;
  full_name: string | null;
};

/**
 * getAuthUser — retourne l'utilisateur courant ou null.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  return {
    id:         user.id,
    email:      user.email ?? null,
    avatar_url: user.user_metadata['avatar_url'] as string | null,
    full_name:  user.user_metadata['full_name']  as string | null,
  };
}

/**
 * signInWithEmail — Magic Link (sans mot de passe).
 */
export async function signInWithEmail(email: string): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw new Error(error.message);
}

/**
 * signInWithGitHub — OAuth redirect.
 */
export async function signInWithGitHub(): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
}

/**
 * signInWithGoogle — OAuth redirect.
 */
export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}
