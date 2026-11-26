/**
 * Logique de la fonction Edge `delete-account` (droit à l'effacement, RGPD
 * art. 17), indépendante de Deno (tests : tests/unit/edge-delete-account.test.ts).
 *
 * - POST seulement, CORS strict ;
 * - JWT vérifié par Supabase Auth ;
 * - confirmation explicite exigée : corps exactement `{ "confirm": "SUPPRIMER" }` ;
 * - au plus 5 tentatives par heure et par utilisateur (`consume_rate_limit`) ;
 * - idempotent : un utilisateur déjà supprimé (jeton encore valide, compte
 *   absent) ou une suppression rejouée renvoie 200 `{ deleted: true }` ;
 * - journaux sans donnée personnelle (identifiant pseudonymisé par HMAC).
 */
import { loadCorsConfig, type CorsConfig } from '../_shared/cors.ts';
import { readEnv, type EnvReader } from '../_shared/env.ts';
import { guardRequest } from '../_shared/guard.ts';
import { bearerToken, errorResponse, jsonResponse, readJsonBody } from '../_shared/http.ts';
import type { AuthPort, RpcPort } from '../_shared/ports.ts';
import { consumeRateLimit } from '../_shared/quota.ts';
import { describeError, hmacHex, type Logger } from '../_shared/redact.ts';
import { isPlainObject, unknownKey } from '../_shared/validate.ts';

export const CONFIRMATION = 'SUPPRIMER';
export const MAX_BODY_BYTES = 1024;
export const ATTEMPTS_PER_HOUR = 5;

export interface DeleteAccountConfig {
  readonly cors: CorsConfig;
  readonly logSecret: string;
}

export function loadDeleteAccountConfig(env: EnvReader): DeleteAccountConfig {
  return {
    cors: loadCorsConfig(env),
    logSecret:
      readEnv(env, 'RATE_LIMIT_SECRET') ?? readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY') ?? 'kinetic',
  };
}

export type DeleteUserResult = 'deleted' | 'not_found' | 'failed';

export interface DeleteAccountDeps {
  readonly config: DeleteAccountConfig;
  readonly auth: AuthPort;
  readonly admin: RpcPort;
  /** Suppression Auth (cascade sur toutes les tables applicatives). */
  readonly deleteUser: (userId: string) => Promise<DeleteUserResult>;
  readonly logger: Logger;
}

export function isConfirmed(body: unknown): boolean {
  return (
    isPlainObject(body) &&
    unknownKey(body, ['confirm']) === null &&
    body['confirm'] === CONFIRMATION
  );
}

export function createDeleteAccountHandler(
  deps: DeleteAccountDeps,
): (req: Request) => Promise<Response> {
  const { config, logger } = deps;
  return async (req) => {
    const guard = guardRequest(req, config.cors, logger);
    if (guard.done) return guard.response;
    const cors = guard.cors;

    const jwt = bearerToken(req);
    if (!jwt) return errorResponse(401, 'unauthorized', 'Connexion requise.', cors);
    let userId: string;
    try {
      const result = await deps.auth.getUser(jwt);
      if (result.status === 'not_found') {
        // Compte déjà supprimé (réponse précédente perdue) : idempotent.
        logger.log('info', 'already_deleted');
        return jsonResponse(200, { deleted: true, alreadyDeleted: true }, cors);
      }
      if (result.status !== 'ok') {
        return errorResponse(401, 'unauthorized', 'Connexion requise.', cors);
      }
      userId = result.user.id;
    } catch (err) {
      logger.log('error', 'auth_unavailable', { detail: describeError(err) });
      return errorResponse(503, 'auth_unavailable', 'Service momentanément indisponible.', cors);
    }

    const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES, requireContentLength: false });
    if (!body.ok && body.status === 413) {
      return errorResponse(413, body.error, body.message, cors);
    }
    if (!body.ok || !isConfirmed(body.value)) {
      return errorResponse(
        400,
        'confirmation_required',
        `Confirmation requise : envoie { "confirm": "${CONFIRMATION}" }.`,
        cors,
      );
    }

    const userTag = (await hmacHex(config.logSecret, userId)).slice(0, 16);
    const limit = await consumeRateLimit(
      deps.admin,
      'delete_account',
      userId,
      ATTEMPTS_PER_HOUR,
      3600,
    );
    if (limit.kind === 'error') {
      logger.log('error', 'rate_limit_unavailable', { user: userTag });
      return errorResponse(
        503,
        'rate_limit_unavailable',
        'Service momentanément indisponible.',
        cors,
      );
    }
    if (limit.kind === 'denied') {
      return errorResponse(
        429,
        'rate_limit_exceeded',
        'Trop de tentatives. Réessaie plus tard.',
        { ...cors, 'Retry-After': String(limit.retryAfterSeconds) },
        { retryAfterSeconds: limit.retryAfterSeconds },
      );
    }

    const outcome = await deps.deleteUser(userId).catch((): DeleteUserResult => 'failed');
    if (outcome === 'failed') {
      logger.log('error', 'delete_failed', { user: userTag });
      return errorResponse(
        500,
        'delete_failed',
        'La suppression a échoué. Tes données sont intactes.',
        cors,
      );
    }
    logger.log('info', 'account_deleted', { user: userTag, already: outcome === 'not_found' });
    return jsonResponse(
      200,
      outcome === 'not_found' ? { deleted: true, alreadyDeleted: true } : { deleted: true },
      cors,
    );
  };
}
