/**
 * Logique de la fonction Edge `send-push`, indépendante de Deno (tests :
 * tests/unit/edge-send-push.test.ts).
 *
 * Fonction SERVEUR → client uniquement (rappels, notifications planifiées) :
 * - appel réservé au `service_role` (`Authorization: Bearer <clé service_role>`)
 *   ou à un secret partagé (`x-push-secret: <PUSH_SHARED_SECRET>`, ≥ 32 car.) ;
 *   un JWT utilisateur est refusé (401) : un client ne déclenche plus d'envoi ;
 * - aucun navigateur : toute requête portant un en-tête `Origin` est refusée ;
 * - anti-SSRF : chaque endpoint est revalidé (https, hôte de service push
 *   connu, ni IP littérale ni port) ; un endpoint refusé n'est jamais contacté
 *   et sa ligne est supprimée ;
 * - au plus 10 abonnements lus, délai maximal par envoi, plafond par
 *   utilisateur destinataire (`consume_rate_limit`) ;
 * - réponses sans détail interne, journaux sans endpoint ni identifiant brut.
 */
import { readEnv, type EnvReader } from '../_shared/env.ts';
import {
  bearerToken,
  errorResponse,
  jsonResponse,
  readJsonBody,
  timingSafeEqual,
} from '../_shared/http.ts';
import type { RpcPort } from '../_shared/ports.ts';
import { checkPushEndpoint } from '../_shared/push-endpoint.ts';
import { consumeRateLimit } from '../_shared/quota.ts';
import { hmacHex, type Logger } from '../_shared/redact.ts';
import {
  boundedString,
  fail,
  isPlainObject,
  isUuid,
  ok,
  unknownKey,
  type Validation,
} from '../_shared/validate.ts';

export const MAX_BODY_BYTES = 4 * 1024;
export const MAX_SUBSCRIPTIONS = 10;
export const SEND_TIMEOUT_MS = 10_000;
export const PUSHES_PER_HOUR = 20;
export const MIN_SHARED_SECRET_LENGTH = 32;

export interface SendPushConfig {
  readonly serviceRoleKey: string | undefined;
  readonly sharedSecret: string | undefined;
  readonly vapidConfigured: boolean;
  readonly logSecret: string;
}

export function loadSendPushConfig(env: EnvReader): SendPushConfig {
  const shared = readEnv(env, 'PUSH_SHARED_SECRET');
  const serviceRoleKey = readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
  return {
    serviceRoleKey,
    // Un secret trop court est ignoré (échec fermé) plutôt qu'accepté.
    sharedSecret: shared && shared.length >= MIN_SHARED_SECRET_LENGTH ? shared : undefined,
    vapidConfigured: Boolean(readEnv(env, 'VAPID_PUBLIC_KEY') && readEnv(env, 'VAPID_PRIVATE_KEY')),
    logSecret: readEnv(env, 'RATE_LIMIT_SECRET') ?? serviceRoleKey ?? 'kinetic',
  };
}

export interface PushSubscriptionRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushRequest {
  readonly userId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag: string;
}

export interface SendPushDeps {
  readonly config: SendPushConfig;
  readonly admin: RpcPort;
  readonly listSubscriptions: (userId: string, limit: number) => Promise<PushSubscriptionRow[]>;
  readonly deleteSubscriptions: (userId: string, endpoints: string[]) => Promise<void>;
  /** Envoi Web Push ; rejette avec `{ statusCode }` en cas de refus du service. */
  readonly sendNotification: (
    sub: PushSubscriptionRow,
    payload: string,
    timeoutMs: number,
  ) => Promise<void>;
  readonly logger: Logger;
}

/** Chemin relatif de l'application uniquement (pas de redirection externe). */
const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/?#=&%]{0,199}$/;
const SAFE_TAG = /^[a-z0-9_-]{1,32}$/;

export function validatePushBody(raw: unknown): Validation<PushRequest> {
  if (!isPlainObject(raw)) return fail('objet JSON attendu');
  const extra = unknownKey(raw, ['user_id', 'title', 'body', 'url', 'tag']);
  if (extra !== null) return fail(`champ inconnu: ${extra}`);
  if (!isUuid(raw['user_id'])) return fail('user_id: UUID attendu');
  const title =
    raw['title'] === undefined ? ok('Kinetic') : boundedString(raw['title'], 'title', 1, 80);
  if (!title.ok) return title;
  const body =
    raw['body'] === undefined
      ? ok("Ta routine t'attend !")
      : boundedString(raw['body'], 'body', 1, 200);
  if (!body.ok) return body;
  const url = raw['url'] ?? '/';
  if (typeof url !== 'string' || !SAFE_PATH.test(url)) return fail('url: chemin relatif attendu');
  const tag = raw['tag'] ?? 'kinetic-reminder';
  if (typeof tag !== 'string' || !SAFE_TAG.test(tag)) return fail('tag: invalide');
  return ok({ userId: raw['user_id'], title: title.value, body: body.value, url, tag });
}

/** Appelant autorisé : clé service_role ou secret partagé (comparaison en temps constant). */
export function isTrustedCaller(req: Request, config: SendPushConfig): boolean {
  const token = bearerToken(req);
  if (token && config.serviceRoleKey && timingSafeEqual(token, config.serviceRoleKey)) return true;
  const shared = req.headers.get('x-push-secret');
  return Boolean(shared && config.sharedSecret && timingSafeEqual(shared, config.sharedSecret));
}

export function createSendPushHandler(deps: SendPushDeps): (req: Request) => Promise<Response> {
  const { config, logger } = deps;
  return async (req) => {
    // Appel serveur à serveur uniquement : aucun en-tête CORS, jamais.
    if (req.headers.get('origin') !== null) {
      return errorResponse(403, 'origin_not_allowed', 'Appel navigateur non autorisé.');
    }
    if (req.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'Méthode non autorisée.', { Allow: 'POST' });
    }
    if (!isTrustedCaller(req, config)) {
      return errorResponse(401, 'unauthorized', 'Appel réservé au serveur.');
    }
    if (!config.vapidConfigured) {
      logger.log('error', 'server_misconfigured', { missing: 'VAPID' });
      return errorResponse(500, 'server_misconfigured', 'Service mal configuré.');
    }

    const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES, requireContentLength: false });
    if (!body.ok) return errorResponse(body.status, body.error, body.message);
    const parsed = validatePushBody(body.value);
    if (!parsed.ok) {
      return errorResponse(
        400,
        'invalid_request',
        'Requête invalide.',
        {},
        { detail: parsed.reason },
      );
    }
    const push = parsed.value;
    const userTag = (await hmacHex(config.logSecret, push.userId)).slice(0, 16);

    const limit = await consumeRateLimit(
      deps.admin,
      'send_push',
      push.userId,
      PUSHES_PER_HOUR,
      3600,
    );
    if (limit.kind === 'error') {
      logger.log('error', 'rate_limit_unavailable', { user: userTag });
      return errorResponse(503, 'rate_limit_unavailable', 'Service momentanément indisponible.');
    }
    if (limit.kind === 'denied') {
      return errorResponse(
        429,
        'rate_limit_exceeded',
        "Trop d'envois pour cet utilisateur.",
        { 'Retry-After': String(limit.retryAfterSeconds) },
        { retryAfterSeconds: limit.retryAfterSeconds },
      );
    }

    let rows: PushSubscriptionRow[];
    try {
      rows = (await deps.listSubscriptions(push.userId, MAX_SUBSCRIPTIONS)).slice(
        0,
        MAX_SUBSCRIPTIONS,
      );
    } catch {
      logger.log('error', 'db_error', { user: userTag });
      return errorResponse(500, 'db_error', 'Erreur interne.');
    }
    if (rows.length === 0)
      return jsonResponse(200, { sent: 0, total: 0, message: 'no_subscriptions' });

    const payload = JSON.stringify({
      title: push.title,
      body: push.body,
      url: push.url,
      tag: push.tag,
    });
    const toDelete: string[] = [];
    let sent = 0;
    let rejected = 0;
    let failed = 0;
    await Promise.all(
      rows.map(async (row) => {
        const check = checkPushEndpoint(row.endpoint);
        if (!check.ok) {
          // Jamais contacté : ligne invalide (antérieure à la contrainte SQL) supprimée.
          rejected += 1;
          toDelete.push(row.endpoint);
          logger.log('warn', 'endpoint_rejected', { user: userTag, reason: check.reason });
          return;
        }
        try {
          await deps.sendNotification(row, payload, SEND_TIMEOUT_MS);
          sent += 1;
        } catch (err) {
          const status = (err as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) toDelete.push(row.endpoint);
          else {
            failed += 1;
            logger.log('warn', 'push_failed', {
              user: userTag,
              status: typeof status === 'number' ? status : null,
            });
          }
        }
      }),
    );
    if (toDelete.length > 0) {
      await deps.deleteSubscriptions(push.userId, toDelete).catch(() => {
        logger.log('warn', 'cleanup_failed', { user: userTag });
      });
    }
    return jsonResponse(200, {
      sent,
      total: rows.length,
      failed,
      rejected,
      cleaned: toDelete.length,
    });
  };
}
