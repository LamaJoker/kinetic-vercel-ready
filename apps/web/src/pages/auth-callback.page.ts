/**
 * auth-callback.page.ts
 *
 * FIX #3 : Le hash (#access_token=...) est lu ici AVANT que le router ne navigue.
 *   Supabase Auth JS détecte automatiquement les tokens dans window.location.hash
 *   via detectSessionInUrl: true dans le client. On doit juste attendre getSession()
 *   ou onAuthStateChange — pas besoin de parser manuellement le hash.
 *
 * FIX #7 : Le timer de 10s est stocké et annulé (destroy()) pour éviter les
 *   mutations de state sur un composant démonté.
 */
import { supabase } from '@kinetic/adapters-web';

export function authCallback() {
  return {
    error: null as string | null,
    _timeoutId: null as ReturnType<typeof setTimeout> | null,
    _subscription: null as { unsubscribe: () => void } | null,

    async init(): Promise<void> {
      try {
        if (!supabase) {
          // Mode guest — pas de Supabase configuré
          window.history.replaceState({}, '', '/');
          window.dispatchEvent(new PopStateEvent('popstate'));
          return;
        }

        // ─── Parse manuel des tokens dans l'URL ────────────────────────────
        // detectSessionInUrl ne se déclenche QUE lors d'un load complet du
        // SDK. En navigation SPA (push/popState), les tokens dans
        // window.location.hash ou .search ne sont jamais extraits → la page
        // reste en attente jusqu'au timeout. On parse manuellement et on
        // appelle setSession()/exchangeCodeForSession() pour fiabiliser.
        const hashStr   = window.location.hash.replace(/^#/, '');
        const hashParams  = new URLSearchParams(hashStr);
        const queryParams = new URLSearchParams(window.location.search);

        // Erreur explicite renvoyée par Supabase ou le provider OAuth
        const errorDesc = hashParams.get('error_description')
          ?? queryParams.get('error_description')
          ?? hashParams.get('error')
          ?? queryParams.get('error');
        if (errorDesc) {
          this.error = decodeURIComponent(errorDesc.replace(/\+/g, ' '));
          return;
        }

        const accessToken  = hashParams.get('access_token')  ?? queryParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token') ?? queryParams.get('refresh_token');
        const code         = queryParams.get('code');

        // Implicit flow : tokens directs dans le hash
        if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token:  accessToken,
            refresh_token: refreshToken,
          });
          if (error) throw error;
          this._navigateHome();
          return;
        }

        // PKCE flow : ?code= → échange contre une session
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
          this._navigateHome();
          return;
        }

        // ─── Pas de tokens dans l'URL : peut-être déjà traités par le SDK ──
        // Force un getSession() pour récupérer la session si detectSessionInUrl
        // a fonctionné lors du load initial (cas plein refresh).
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session) {
          this._navigateHome();
          return;
        }

        // ─── Attendre SIGNED_IN au cas où le SDK traite le hash en async ──
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
          if (event === 'SIGNED_IN' && s) {
            this._cleanup();
            this._navigateHome();
          }
        });
        this._subscription = subscription;

        // FIX #7 : Stocker le timer pour le cleanup dans destroy()
        this._timeoutId = setTimeout(() => {
          this._cleanup();
          this.error = 'Délai dépassé — aucun token reçu. Vérifie la config Supabase (Redirect URLs) ou clique à nouveau sur le lien magique.';
        }, 10_000);

      } catch (e) {
        this._cleanup();
        this.error = e instanceof Error ? e.message : 'Erreur de connexion';
      }
    },

    _navigateHome(): void {
      // Effacer le hash OAuth de la barre d'adresse proprement AVANT de naviguer
      // → évite une boucle si l'utilisateur fait "retour arrière"
      window.history.replaceState({}, '', '/');
      // Déclencher le router SPA (équivalent de navigate('/'))
      window.dispatchEvent(new PopStateEvent('popstate'));
    },

    /** FIX #7 : Annuler timer + subscription pour éviter les mutations sur composant démonté */
    _cleanup(): void {
      if (this._timeoutId !== null) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      this._subscription?.unsubscribe();
      this._subscription = null;
    },

    /** Appelé par Alpine/router lors du démontage du composant */
    destroy(): void {
      this._cleanup();
    },
  };
}
