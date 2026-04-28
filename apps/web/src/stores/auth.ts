/**
 * Store Alpine `auth` — état de session Supabase.
 * FIX: kinetic:auth-ready dispatché dans tous les cas (guest + Supabase)
 */
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import {
  supabase, getAuthUser, signInWithEmail,
  signInWithGitHub, signInWithGoogle, signOut,
  authRateLimiter,
} from '@kinetic/adapters-web';
import type { AuthUser } from '@kinetic/adapters-web';
import { resetDeps } from '../deps';

const GUEST_MODE = supabase === null
  || (import.meta.env['VITE_SUPABASE_URL'] as string | undefined)?.includes('xxxxxxxxxxxxxxxxxxxx')
  || false;

function dispatchAuthReady(): void {
  window.dispatchEvent(new CustomEvent('kinetic:auth-ready'));
}

export function authStore() {
  return {
    user:          null as AuthUser | null,
    loading:       true,
    error:         null as string | null,
    magicLinkSent: false,
    emailInput:    '',

    async init(): Promise<void> {
      try {
        if (GUEST_MODE) {
          this.user = { id: 'guest', email: null, full_name: 'Invité', avatar_url: null };
          return;
        }

        // Timeout 3s sur getAuthUser pour éviter le blocage
        const userPromise = getAuthUser();
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
        const user = await Promise.race([userPromise, timeout]);
        this.user = user;

        supabase!.auth.onAuthStateChange(async (_event: AuthChangeEvent, session: Session | null) => {
          if (session?.user) {
            this.user = await getAuthUser();
          } else {
            this.user = null;
            resetDeps();
          }
          this.loading = false;
          dispatchAuthReady();
        });
      } catch (err) {
        console.error('[auth] init failed:', err);
        this.error = err instanceof Error ? err.message : 'Erreur auth';
        this.user = { id: 'guest', email: null, full_name: 'Invité', avatar_url: null };
      } finally {
        this.loading = false;
        dispatchAuthReady();
      }
    },

    async loginWithEmail(): Promise<void> {
      this.error = null;
      const email = this.emailInput.trim().toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        this.error = 'Adresse email invalide';
        return;
      }

      if (!authRateLimiter.canSendMagicLink(email)) {
        const waitSec = Math.ceil(authRateLimiter.getWaitTimeMs(email) / 1000);
        this.error = `Trop de tentatives. Réessaie dans ${waitSec}s.`;
        return;
      }

      try {
        authRateLimiter.recordMagicLink(email);
        await signInWithEmail(email);
        this.magicLinkSent = true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Erreur inconnue';
      }
    },

    async loginWithGitHub(): Promise<void> {
      this.error = null;
      if (!authRateLimiter.canOAuth()) {
        this.error = 'Trop de tentatives. Attends un moment.';
        return;
      }
      try {
        authRateLimiter.recordOAuth();
        await signInWithGitHub();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Erreur GitHub';
      }
    },

    async loginWithGoogle(): Promise<void> {
      this.error = null;
      if (!authRateLimiter.canOAuth()) {
        this.error = 'Trop de tentatives. Attends un moment.';
        return;
      }
      try {
        authRateLimiter.recordOAuth();
        await signInWithGoogle();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Erreur Google';
      }
    },

    async logout(): Promise<void> {
      await signOut();
      window.location.href = '/login';
    },

    get isAuthenticated(): boolean {
      return this.user !== null;
    },

    get initials(): string {
      const name = this.user?.full_name ?? this.user?.email ?? '?';
      return name.split(/\s+|@/).filter(Boolean).map((n) => n[0] ?? '').join('').toUpperCase().slice(0, 2) || '?';
    },
  };
}
