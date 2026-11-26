/**
 * Interfaces des dépendances injectées dans les handlers. `index.ts` les
 * implémente avec supabase-js (Deno) ; les tests avec des faux en mémoire.
 */

export interface AuthUser {
  readonly id: string;
}

/**
 * Résultat de la vérification d'un JWT par Supabase Auth (`auth.getUser(jwt)`,
 * appel serveur : la signature et la révocation sont vérifiées par Auth).
 * - `invalid` : jeton absent, expiré, falsifié ;
 * - `not_found` : jeton valide mais utilisateur supprimé ;
 * - une exception signale un service Auth indisponible (→ 503).
 */
export type AuthResult =
  | { readonly status: 'ok'; readonly user: AuthUser }
  | { readonly status: 'invalid' }
  | { readonly status: 'not_found' };

export interface AuthPort {
  getUser(jwt: string): Promise<AuthResult>;
}

export interface RpcError {
  readonly code?: string;
  readonly message: string;
}

/** Appel RPC PostgREST avec le client `service_role`. */
export interface RpcPort {
  rpc(
    fn: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ data: unknown; error: RpcError | null }>;
}
