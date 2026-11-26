/**
 * Adaptateurs Deno des ports de `_shared/ports.ts` (supabase-js via esm.sh).
 *
 * Seul endroit, avec les `index.ts`, à importer du code distant : la logique
 * testable reste dans `_shared/` et `<fonction>/handler.ts`. Vérifié par
 * `deno check` (pas par le tsc du monorepo).
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import type { EnvReader } from '../_shared/env.ts';
import type { AuthPort, AuthResult, RpcPort } from '../_shared/ports.ts';
import type { LogSink } from '../_shared/redact.ts';

export const denoEnv: EnvReader = (name) => Deno.env.get(name);

export const consoleSink: LogSink = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Client `service_role`, ou `null` si la configuration est incomplète. */
export function adminClient(env: EnvReader): SupabaseClient | null {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? createClient(url, key, CLIENT_OPTIONS) : null;
}

/**
 * Vérification du JWT par Supabase Auth (`GET /auth/v1/user`) : signature,
 * expiration et existence de l'utilisateur sont contrôlées côté serveur.
 */
export function authPort(client: SupabaseClient | null): AuthPort {
  return {
    async getUser(jwt: string): Promise<AuthResult> {
      if (!client) throw new Error('supabase_not_configured');
      const { data, error } = await client.auth.getUser(jwt);
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === 'user_not_found') return { status: 'not_found' };
        if (error.status !== undefined && error.status >= 500) throw new Error('auth_unavailable');
        return { status: 'invalid' };
      }
      return data.user ? { status: 'ok', user: { id: data.user.id } } : { status: 'invalid' };
    },
  };
}

export function rpcPort(client: SupabaseClient | null): RpcPort {
  return {
    async rpc(fn, args) {
      if (!client) return { data: null, error: { message: 'supabase_not_configured' } };
      const { data, error } = await client.rpc(fn, args);
      return {
        data: data as unknown,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}
