/**
 * stores/auth.ts
 *
 * FIX #1 : dispatchAuthReady() appelé UNE SEULE FOIS.
 *   Avant : appelé dans finally() ET dans onAuthStateChange → double navigation.
 *   Après : seul le finally() dispatche. onAuthStateChange réagit uniquement
 *   aux changements APRÈS l'init initiale (ex: logout, refresh de token).
 *
 * FIX #4 : Logging explicite si la clé Supabase a un format inconnu — l'app
 *   ne se dégrade pas silencieusement en mode guest sans avertissement console.
 *
 * FIX #5 : Timeout porté à 8s (cold starts Supabase / 3G). Plus important :
 *   si onAuthStateChange arrive APRÈS le timeout (user connecté sur réseau lent),
 *   on rebascule sur HybridStorage au lieu de rester bloqué en mode local.
 */
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import {
  supabase, getAuthUser, signInWithEmail,
  signInWithGitHub, signInWithGoogle, signOut,
  authRateLimiter, callbackUrl,
} from '@kinetic/adapters-web';
import type { AuthUser } from '@kinetic/adapters-web';
import { resetDeps } from '../deps';

// FIX #4 : Log explicite plutôt que dégradation silencieuse
const SUPABASE_URL      = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

const GUEST_MODE = supabase === null;

if (GUEST_MODE && SUPABASE_URL && !SUPABASE_URL.includes('xxxxxxxxxxxxxxxxxxxx')) {
  // L'URL est configurée mais le client est null → clé probablement invalide
  console.warn(
    '[auth] Supabase client is null. Check VITE_SUPABASE_ANON_KEY format. ' +
    'Expected: starts with "eyJ" (JWT) or "sb_publishable_". ' +
    `Got: "${SUPABASE_ANON_KEY?.slice(0, 20) ?? 'undefined'}..."`
  );
}

let _authReadyDispatched = false; // FIX #1 : guard contre le double dispatch

function dispatchAuthReady(): void {
  if (_authReadyDispatched) return; // FIX #1 : idempotent
  _authReadyDispatched = true;
  window.dispatchEvent(new CustomEvent('kinetic:auth-ready'));
}

export function authStore() {
  return {
    user:          null as AuthUser | null,
    loading:       true,
    error:         null as string | null,
    magicLinkSent: false,
    emailInput:    '',
    /** FIX #5 : track si on est déjà allé chercher l'user une fois */
    _initDone:     false,
    /** H5 FIX : handle pour unsubscribe à la destruction */
    _authSubscription: null as { unsubscribe: () => void } | null,

    async init(): Promise<void> {
      _authReadyDispatched = false; // reset au cas où le store est réinstancié

      try {
        if (GUEST_MODE) {
          this.user = { id: 'guest', email: null, full_name: 'Invité', avatar_url: null };
          return;
        }

        // FIX #5 : Timeout porté à 8s pour les connexions lentes
        const userPromise = getAuthUser();
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
        const user = await Promise.race([userPromise, timeout]);
        this.user = user;
        this._initDone = true;

        // FIX #1 : onAuthStateChange NE dispatche plus authReady.
        //   Il gère uniquement les transitions POST-init :
        //   - SIGNED_IN après un magic link / OAuth (si l'init a timeout)
        //   - SIGNED_OUT sur logout
        //   - TOKEN_REFRESHED en arrière-plan
        const { data: { subscription } } = supabase!.auth.onAuthStateChange(async (event: AuthChangeEvent, session: Session | null) => {
          if (session?.user) {
            const freshUser = await getAuthUser();
            this.user = freshUser;

            // FIX #5 : Si l'init avait timeout (user null), on rebascule les deps
            // sur HybridStorage maintenant qu'on sait que l'user est connecté.
            if (!this._initDone || !freshUser) {
              this._initDone = true;
              resetDeps(); // force la reconstruction avec SupabaseStorage
              // Note : les stores Alpine rechargeront leurs données au prochain getDeps()
            }
          } else if (event === 'SIGNED_OUT') {
            // Déconnexion explicite : réinitialiser les deps vers le mode local.
            // NE PAS appeler resetDeps() sur INITIAL_SESSION null — ce serait
            // l'état normal d'un utilisateur non connecté au démarrage.
            // Appeler resetDeps() sur INITIAL_SESSION force un double getDeps()
            // (8s Supabase timeout × 2) avant que la page se rende.
            this.user = null;
            resetDeps();
          } else if (!session?.user) {
            // INITIAL_SESSION, TOKEN_REFRESHED, etc. sans session active :
            // mettre à jour l'état local sans invalider le cache deps.
            this.user = null;
          }
          this.loading = false;

          // FIX #1 : Pas de dispatchAuthReady ici — le finally() s'en charge.
          // Exception : si l'init a timeout ET que SIGNED_IN arrive après, on
          // dispatche une notification de mise à jour pour que les composants
          // qui en ont besoin puissent se recharger (ex: dashboard).
          if (event === 'SIGNED_IN' && _authReadyDispatched) {
            window.dispatchEvent(new CustomEvent('kinetic:auth-changed'));
          }
        });
        this._authSubscription = subscription;

      } catch (err) {
        console.error('[auth] init failed:', err);
        this.error = err instanceof Error ? err.message : 'Erreur auth';
        this.user = { id: 'guest', email: null, full_name: 'Invité', avatar_url: null };
      } finally {
        this.loading = false;
        dispatchAuthReady(); // FIX #1 : dispatché UNE SEULE FOIS ici
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

    destroy(): void {
      this._authSubscription?.unsubscribe();
      this._authSubscription = null;
    },

    /** Diagnostic : URL de callback qui sera envoyée à Supabase */
    _diagCallbackUrl(): string {
      try { return callbackUrl(); } catch { return '(erreur)'; }
    },

    /** Diagnostic : URL Supabase configurée */
    _diagSupabaseUrl(): string {
      return SUPABASE_URL ?? '(non définie)';
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
