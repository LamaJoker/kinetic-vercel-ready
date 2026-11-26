/**
 * Logique de la fonction Edge `report-error` (collecte d'erreurs du client),
 * indépendante de Deno (tests : tests/unit/edge-report-error.test.ts).
 *
 * - CORS strict, POST seulement, corps JSON ≤ 64 Ko (lecture bornée) ;
 * - schéma strict : `{ userAgent?, reports: [{ occurredAt, message, source }] }`,
 *   champs bornés ; au plus 50 rapports traités par appel ;
 * - limite de débit : par utilisateur (JWT valide) ou par IP pseudonymisée
 *   (HMAC avec RATE_LIMIT_SECRET), plus un plafond global ; échec fermé ;
 * - données personnelles masquées (e-mails, jetons, identifiants…) avant
 *   journalisation et avant le webhook ; mentions `@everyone` neutralisées et
 *   `allowed_mentions` vide côté Discord.
 */
import { loadCorsConfig, type CorsConfig } from '../_shared/cors.ts';
import { readEnv, type EnvReader } from '../_shared/env.ts';
import { guardRequest } from '../_shared/guard.ts';
import { bearerToken, errorResponse, jsonResponse, readJsonBody } from '../_shared/http.ts';
import type { AuthPort, RpcPort } from '../_shared/ports.ts';
import { consumeRateLimit } from '../_shared/quota.ts';
import { hmacHex, neutralizeMentions, redactSensitive, type Logger } from '../_shared/redact.ts';
import {
  boundedString,
  fail,
  isPlainObject,
  ok,
  unknownKey,
  type Validation,
} from '../_shared/validate.ts';

export const MAX_BODY_BYTES = 64 * 1024;
/** Taille de tableau acceptée (anciens clients) / nombre de rapports traités. */
export const MAX_REPORTS_ACCEPTED = 200;
export const MAX_REPORTS_PROCESSED = 50;
export const USER_LIMIT_PER_HOUR = 20;
export const IP_LIMIT_PER_HOUR = 30;
export const GLOBAL_LIMIT_PER_HOUR = 2000;
export const WEBHOOK_TIMEOUT_MS = 5_000;
const SOURCES = ['unhandled_rejection', 'uncaught_error', 'manual'] as const;

export interface ReportErrorConfig {
  readonly cors: CorsConfig;
  readonly webhookUrl: string | undefined;
  readonly anonKey: string | undefined;
  readonly rateLimitSecret: string | undefined;
  /**
   * Nombre de mandataires de confiance qui AJOUTENT une entrée à
   * `X-Forwarded-For` devant la fonction (1 par défaut : la passerelle Supabase).
   */
  readonly trustedProxyHops: number;
}

/** `TRUSTED_PROXY_HOPS` : entier de 1 à 5, sinon 1. */
function readProxyHops(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
}

export function loadReportErrorConfig(env: EnvReader): ReportErrorConfig {
  const webhook = readEnv(env, 'ERROR_WEBHOOK_URL');
  return {
    cors: loadCorsConfig(env),
    // Webhook HTTPS uniquement.
    webhookUrl: webhook && webhook.startsWith('https://') ? webhook : undefined,
    anonKey: readEnv(env, 'SUPABASE_ANON_KEY'),
    rateLimitSecret: readEnv(env, 'RATE_LIMIT_SECRET') ?? readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    trustedProxyHops: readProxyHops(readEnv(env, 'TRUSTED_PROXY_HOPS')),
  };
}

export interface ErrorReport {
  readonly occurredAt: string;
  readonly message: string;
  readonly source: (typeof SOURCES)[number];
}

export interface ReportBatch {
  readonly userAgent: string;
  readonly reports: readonly ErrorReport[];
}

export interface ReportErrorDeps {
  readonly config: ReportErrorConfig;
  readonly auth: AuthPort;
  readonly admin: RpcPort;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
}

function validateReport(raw: unknown): Validation<ErrorReport> {
  if (!isPlainObject(raw) || unknownKey(raw, ['occurredAt', 'message', 'source']) !== null) {
    return fail('rapport invalide');
  }
  const occurredAt = boundedString(raw['occurredAt'], 'occurredAt', 1, 40);
  if (!occurredAt.ok) return occurredAt;
  // Les messages contiennent souvent des retours à la ligne (piles) : tolérés.
  const message = boundedString(raw['message'], 'message', 1, 1000);
  if (!message.ok) return message;
  const source = raw['source'];
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) {
    return fail('source invalide');
  }
  return ok({
    occurredAt: occurredAt.value,
    message: message.value,
    source: source as ErrorReport['source'],
  });
}

export function validateReportBody(raw: unknown): Validation<ReportBatch> {
  if (!isPlainObject(raw)) return fail('objet JSON attendu');
  const extra = unknownKey(raw, ['userAgent', 'reports']);
  if (extra !== null) return fail(`champ inconnu: ${extra}`);
  const ua =
    raw['userAgent'] === undefined
      ? ok('unknown')
      : boundedString(raw['userAgent'], 'userAgent', 0, 300);
  if (!ua.ok) return ua;
  const list = raw['reports'];
  if (!Array.isArray(list)) return fail('reports: tableau attendu');
  if (list.length > MAX_REPORTS_ACCEPTED) return fail('reports: trop nombreux');
  const reports: ErrorReport[] = [];
  for (const item of list.slice(0, MAX_REPORTS_PROCESSED)) {
    const r = validateReport(item);
    if (!r.ok) return r;
    reports.push(r.value);
  }
  return ok({ userAgent: ua.value, reports });
}

/**
 * IP du client telle que vue par le mandataire de confiance le plus éloigné.
 *
 * Le client peut envoyer son propre `X-Forwarded-For` : chaque mandataire
 * AJOUTE l'adresse de son interlocuteur à la fin. Seules les `hops` dernières
 * entrées sont donc fiables ; la première est choisie par le client (la
 * prendre permettait de contourner la limite par IP, de vider le plafond
 * global et d'épuiser le quota d'une victime en usurpant son adresse).
 * `cf-connecting-ip` est ignoré : falsifiable si la passerelle ne le réécrit pas.
 */
export function clientIp(req: Request, hops = 1): string {
  const entries = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length === 0) return 'inconnue';
  return entries[Math.max(0, entries.length - hops)]!;
}

const FENCE = '```';
const WEBHOOK_MAX = 1900;

/**
 * Texte prêt pour un webhook Discord/Slack : masqué, sans mention, ≤ 1 900
 * caractères. Le contenu fourni par le client est placé dans UN bloc de code
 * (accents graves remplacés) : ni lien masqué `[texte](url)`, ni `<url|texte>`,
 * ni mise en forme ne sont interprétés dans le canal de l'équipe.
 */
export function formatWebhookContent(batch: ReportBatch): string {
  const lines = batch.reports.map(
    (r) =>
      `[${redactSensitive(r.occurredAt, 40)}] ${r.source} — ${redactSensitive(r.message, 300)}`,
  );
  const header = `Kinetic — ${batch.reports.length} erreur(s)`;
  const body = neutralizeMentions(
    `UA: ${redactSensitive(batch.userAgent, 200)}\n${lines.join('\n')}`,
  ).replace(/`/g, 'ˋ');
  const room = WEBHOOK_MAX - header.length - 2 * FENCE.length - 3;
  let clipped = body.slice(0, room);
  // Pas de demi-paire de substitution en fin de texte tronqué.
  const last = clipped.charCodeAt(clipped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return `${header}\n${FENCE}\n${clipped}\n${FENCE}`;
}

export function createReportErrorHandler(
  deps: ReportErrorDeps,
): (req: Request) => Promise<Response> {
  const { config, logger } = deps;
  return async (req) => {
    const guard = guardRequest(req, config.cors, logger);
    if (guard.done) return guard.response;
    const cors = guard.cors;
    if (!config.rateLimitSecret) {
      logger.log('error', 'server_misconfigured', { missing: 'RATE_LIMIT_SECRET' });
      return errorResponse(
        503,
        'server_misconfigured',
        'Service momentanément indisponible.',
        cors,
      );
    }

    const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES, requireContentLength: false });
    if (!body.ok) return errorResponse(body.status, body.error, body.message, cors);
    const parsed = validateReportBody(body.value);
    if (!parsed.ok) {
      return errorResponse(400, 'invalid_request', 'Requête invalide.', cors, {
        detail: parsed.reason,
      });
    }
    const batch = parsed.value;
    if (batch.reports.length === 0)
      return jsonResponse(200, { ok: true, received: 0, forwarded: 0 }, cors);

    // Identité pour la limite : utilisateur si JWT valide, sinon IP pseudonymisée.
    let scope = 'report_error_ip';
    let subject = await hmacHex(
      config.rateLimitSecret,
      `ip:${clientIp(req, config.trustedProxyHops)}`,
    );
    const jwt = bearerToken(req);
    if (jwt && jwt !== config.anonKey) {
      const result = await deps.auth.getUser(jwt).catch(() => null);
      if (result?.status === 'ok') {
        scope = 'report_error_user';
        subject = result.user.id;
      }
    }
    const perSubject = await consumeRateLimit(
      deps.admin,
      scope,
      subject,
      scope === 'report_error_user' ? USER_LIMIT_PER_HOUR : IP_LIMIT_PER_HOUR,
      3600,
    );
    const global =
      perSubject.kind === 'allowed'
        ? await consumeRateLimit(
            deps.admin,
            'report_error_global',
            'global',
            GLOBAL_LIMIT_PER_HOUR,
            3600,
          )
        : perSubject;
    if (global.kind === 'error') {
      logger.log('error', 'rate_limit_unavailable');
      return errorResponse(
        503,
        'rate_limit_unavailable',
        'Service momentanément indisponible.',
        cors,
      );
    }
    if (global.kind === 'denied') {
      return errorResponse(
        429,
        'rate_limit_exceeded',
        'Trop de rapports. Réessaie plus tard.',
        { ...cors, 'Retry-After': String(global.retryAfterSeconds) },
        { retryAfterSeconds: global.retryAfterSeconds },
      );
    }

    for (const r of batch.reports) {
      logger.log('info', 'client_error', {
        at: r.occurredAt,
        source: r.source,
        message: redactSensitive(r.message, 500),
      });
    }

    let forwarded = 0;
    if (config.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const resp = await deps.fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: formatWebhookContent(batch),
            allowed_mentions: { parse: [] },
          }),
          signal: controller.signal,
        });
        await resp.body?.cancel().catch(() => undefined);
        if (resp.ok) forwarded = batch.reports.length;
        else logger.log('warn', 'webhook_failed', { status: resp.status });
      } catch {
        logger.log('warn', 'webhook_failed', { status: null });
      } finally {
        clearTimeout(timer);
      }
    }
    return jsonResponse(200, { ok: true, received: batch.reports.length, forwarded }, cors);
  };
}
