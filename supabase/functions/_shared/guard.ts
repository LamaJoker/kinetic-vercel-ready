/**
 * Garde commune en tête de chaque fonction Edge : CORS strict, requête
 * préliminaire OPTIONS, méthode autorisée.
 */
import { evaluateCors, type CorsConfig } from './cors.ts';
import { errorResponse } from './http.ts';
import type { Logger } from './redact.ts';

export type GuardResult =
  | { readonly done: true; readonly response: Response }
  | { readonly done: false; readonly cors: Readonly<Record<string, string>> };

export function guardRequest(req: Request, cors: CorsConfig, logger: Logger): GuardResult {
  const decision = evaluateCors(req.headers.get('origin'), cors);
  if (decision.kind === 'misconfigured') {
    logger.log('error', 'cors_not_configured');
    return {
      done: true,
      response: errorResponse(
        503,
        'cors_not_configured',
        'Service momentanément indisponible (configuration incomplète).',
      ),
    };
  }
  if (decision.kind === 'forbidden') {
    return {
      done: true,
      response: errorResponse(403, 'origin_not_allowed', 'Origine non autorisée.', {
        Vary: 'Origin',
      }),
    };
  }
  if (req.method === 'OPTIONS') {
    return { done: true, response: new Response(null, { status: 204, headers: decision.headers }) };
  }
  if (req.method !== 'POST') {
    return {
      done: true,
      response: errorResponse(405, 'method_not_allowed', 'Méthode non autorisée.', {
        ...decision.headers,
        Allow: 'POST, OPTIONS',
      }),
    };
  }
  return { done: false, cors: decision.headers };
}
