/**
 * Remplace `@supabase/auth-js/…/GoTrueAdminApi` (non utilisé) : voir ./unused.ts.
 * L'API d'administration exige la clé `service_role`, qui n'est jamais dans une
 * application cliente : `auth.admin` ne peut donc servir à rien dans Kinetic.
 */
import { unavailable } from './unused';

export default class GoTrueAdminApi {
  constructor(_settings?: unknown) {
    return new Proxy(this, {
      get: (target, prop, receiver) =>
        typeof prop === 'string' && !(prop in target)
          ? () => unavailable('Auth admin')
          : Reflect.get(target, prop, receiver),
    });
  }
}
