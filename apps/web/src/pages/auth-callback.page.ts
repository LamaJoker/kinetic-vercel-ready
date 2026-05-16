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
 *
 * FIX APK about:blank : Sur Capacitor, callbackUrl() pointe désormais vers
 *   /auth-callback HTTPS (et non plus le custom scheme com.lamajoker.kinetic://).
 *   Chrome Custom Tabs ne peut pas naviguer vers un custom scheme après OAuth →
 *   about:blank. Le flow corrigé :
 *     1. Google/Supabase redirige vers https://…/auth-callback (HTTPS, OK dans CTab)
 *     2. Cette page parse les tokens
 *     3. Si on est dans un WebView Capacitor → hand-off vers le deep link APK
 *        via window.location.href = 'com.lamajoker.kinetic://auth-callback#tokens'
 *        afin que l'APK prenne la main (Intent filter Android)
 *     4. Sinon (web) → naviguer vers /
 */
import { supabase } from '@kinetic/adapters-web';

/** Détecte si on est dans un WebView Capacitor (APK Android/iOS) */
const _isCapacitor =
  typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>)['Capacitor'];

/**
 * Détecte si la page a été ouverte depuis l'APK via OAuth.
 *
 * `_isCapacitor` ne suffit PAS : la page /auth-callback tourne dans Chrome
 * Custom Tabs (le navigateur lancé par Browser.open), pas dans la WebView de
 * l'APK → `window.Capacitor` est undefined ici → on raterait le hand-off.
 *
 * Solution : signInWithOAuth/Email passe `?from=apk` dans l'URL de callback.
 * Si on voit ce marqueur, on déclenche le deep link même si _isCapacitor est
 * faux (cas normal : page chargée dans Chrome, pas dans l'APK).
 */
function _shouldHandoffToApk(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('from') === 'apk' || _isCapacitor;
  } catch {
    return _isCapacitor;
  }
}

async function waitForSessionTokens(
  attempts = 5,
  delayMs = 150,
): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  if (!supabase) return null;

  for (let i = 0; i < attempts; i++) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.access_token && session?.refresh_token) {
        return {
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
        };
      }
    } catch {
      return null;
    }

    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

export function authCallback() {
  return {
    error: null as string | null,
    /** Deep link à afficher au cas où le redirect automatique est bloqué */
    apkDeepLink: '' as string,
    /** Tokens implicit flow gardés pour le fallback "Continuer sur le web" */
    _pendingTokens: null as { accessToken: string; refreshToken: string } | null,
    /** Code PKCE gardé pour le fallback "Continuer sur le web" */
    _pendingCode: '' as string,
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
        const hashStr = window.location.hash.replace(/^#/, '');
        const hashParams = new URLSearchParams(hashStr);
        const queryParams = new URLSearchParams(window.location.search);

        // Erreur explicite renvoyée par Supabase ou le provider OAuth
        const errorDesc =
          hashParams.get('error_description') ??
          queryParams.get('error_description') ??
          hashParams.get('error') ??
          queryParams.get('error');
        if (errorDesc) {
          this.error = decodeURIComponent(errorDesc.replace(/\+/g, ' '));
          return;
        }

        let accessToken = hashParams.get('access_token') ?? queryParams.get('access_token');
        let refreshToken = hashParams.get('refresh_token') ?? queryParams.get('refresh_token');
        const code = queryParams.get('code');
        const handoffApk = _shouldHandoffToApk();

        // ─── BUG FIX critique (8 mai 2026) ─────────────────────────────────
        // Supabase est configuré avec `detectSessionInUrl: true`. Il consomme
        // automatiquement les tokens du hash AU CHARGEMENT de la page, AVANT
        // que ce code ne s'exécute → tokens null dans l'URL → on aurait raté
        // le handoff APK et navigué directement vers / dans le navigateur.
        //
        // Solution : si on est sur /auth-callback?from=apk et que les tokens
        // ne sont plus dans l'URL, on récupère la session que Supabase vient
        // de poser et on extrait les tokens pour le deep link.
        if (handoffApk && (!accessToken || !refreshToken) && !code) {
          const sessionTokens = await waitForSessionTokens();
          if (sessionTokens) {
            accessToken = sessionTokens.accessToken;
            refreshToken = sessionTokens.refreshToken;
          }
        }

        // Implicit flow : tokens directs (URL ou session déjà posée)
        if (accessToken && refreshToken) {
          // Si la requête vient de l'APK, on NE fait PAS de fallback web :
          // sinon le user se retrouve connecté dans Chrome/Brave au lieu de
          // l'APK. Le bouton manuel est l'unique chemin fiable. Escape hatch
          // "Continuer sur le web" disponible pour les cas PC sans APK.
          if (handoffApk) {
            const deepLink =
              `com.lamajoker.kinetic://auth-callback` +
              `#access_token=${encodeURIComponent(accessToken)}` +
              `&refresh_token=${encodeURIComponent(refreshToken)}` +
              `&token_type=bearer`;
            this.apkDeepLink = deepLink;
            this._pendingTokens = { accessToken, refreshToken };
            this._tryAutoOpenApk(deepLink);
            return;
          }
          await this._setSessionAndNavigate(accessToken, refreshToken);
          return;
        }

        // PKCE flow : ?code= → échange contre une session
        if (code) {
          if (handoffApk) {
            const deepLink = `com.lamajoker.kinetic://auth-callback?code=${encodeURIComponent(code)}`;
            this.apkDeepLink = deepLink;
            this._pendingCode = code;
            this._tryAutoOpenApk(deepLink);
            return;
          }
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
          this._navigateHome();
          return;
        }

        // ─── Pas de tokens NI de session : web flow normal sans tokens ─────
        // Force un getSession() pour récupérer la session si elle existe (cas
        // d'un re-load de la page après auth réussie).
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();
        if (error) throw error;

        if (session) {
          // Si on arrive ici avec une session ET handoffApk, on a essayé plus
          // haut et n'a pas pu extraire les tokens — on tombe en navigation
          // web (pas idéal mais évite un blocage).
          this._navigateHome();
          return;
        }

        // ─── Attendre SIGNED_IN au cas où le SDK traite le hash en async ──
        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((event, s) => {
          if (event === 'SIGNED_IN' && s) {
            this._cleanup();
            // Si APK demandé, retenter le handoff avec la session fraîche
            if (handoffApk && s.access_token && s.refresh_token) {
              const deepLink =
                `com.lamajoker.kinetic://auth-callback` +
                `#access_token=${encodeURIComponent(s.access_token)}` +
                `&refresh_token=${encodeURIComponent(s.refresh_token)}` +
                `&token_type=bearer`;
              this.apkDeepLink = deepLink;
              this._pendingTokens = { accessToken: s.access_token, refreshToken: s.refresh_token };
              this._tryAutoOpenApk(deepLink);
            } else {
              this._navigateHome();
            }
          }
        });
        this._subscription = subscription;

        this._timeoutId = setTimeout(() => {
          this._cleanup();
          this.error =
            'Délai dépassé — aucun token reçu. Vérifie la config Supabase (Redirect URLs) ou clique à nouveau sur le lien magique.';
        }, 10_000);
      } catch (e) {
        this._cleanup();
        this.error = e instanceof Error ? e.message : 'Erreur de connexion';
      }
    },

    /**
     * Tente d'ouvrir l'APK via plusieurs stratégies. Chrome Custom Tabs bloque
     * `window.location.href` vers un scheme custom sans user gesture. On
     * combine donc trois approches en cascade :
     *   1. <a> programmatique cliqué (gesture simulé — souvent autorisé)
     *   2. Android intent URL (`intent://...;scheme=...;package=...;end`) qui
     *      est nativement supporté par Chrome et bypasse les heuristiques
     *      anti-redirect
     *   3. window.location.href en dernier recours (souvent silencieux mais
     *      coûte rien à essayer)
     *
     * Si aucune des trois ne marche, le bouton "Ouvrir dans Kinetic" affiché
     * dans le template prend le relais (clic utilisateur direct = autorisé).
     */
    _tryAutoOpenApk(deepLink: string): void {
      // Strat 1 : <a> programmatique
      try {
        const a = document.createElement('a');
        a.href = deepLink;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch {
        /* ignore */
      }

      // Strat 2 : Android intent URL — décode le deep link et reformule
      // au format intent: que Chrome traite spécialement (ouverture native
      // garantie si le package est trouvé, sinon fallback URL preserve le state).
      try {
        // deepLink = "com.lamajoker.kinetic://auth-callback#access_token=..."
        const match = deepLink.match(/^com\.lamajoker\.kinetic:\/\/(.+)$/);
        if (match) {
          const pathAndHash = match[1] ?? '';
          const intentUrl =
            `intent://${pathAndHash}` +
            `#Intent;scheme=com.lamajoker.kinetic;` +
            `package=com.lamajoker.kinetic;` +
            `end`;
          // Petit délai pour laisser strat 1 sa chance avant d'essayer la 2
          setTimeout(() => {
            try {
              window.location.href = intentUrl;
            } catch {
              /* ignore */
            }
          }, 250);
        }
      } catch {
        /* ignore */
      }
    },

    /**
     * Escape hatch : appelé quand l'utilisateur clique "Continuer sur le web
     * à la place" (cas PC sans APK, ou utilisateur qui veut juste tester).
     * Établit la session sur le client web et navigue vers /.
     */
    async continueOnWeb(): Promise<void> {
      try {
        if (this._pendingTokens) {
          await this._setSessionAndNavigate(
            this._pendingTokens.accessToken,
            this._pendingTokens.refreshToken,
          );
        } else if (this._pendingCode && supabase) {
          const { error } = await supabase.auth.exchangeCodeForSession(this._pendingCode);
          if (error) throw error;
          this._navigateHome();
        } else {
          this._navigateHome();
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Erreur de session';
      }
    },

    async _setSessionAndNavigate(accessToken: string, refreshToken: string): Promise<void> {
      if (!supabase) {
        this._navigateHome();
        return;
      }
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) throw error;
      this._navigateHome();
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
      this.apkDeepLink = '';
    },

    /** Appelé par Alpine/router lors du démontage du composant */
    destroy(): void {
      this._cleanup();
    },
  };
}
