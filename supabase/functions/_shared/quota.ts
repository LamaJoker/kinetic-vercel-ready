/**
 * Lecture stricte des réponses des RPC de quota (migration 011, voir
 * docs/architecture/security.md « Interface SQL pour les fonctions Edge »).
 * Toute réponse inattendue est traitée comme une erreur : échec fermé.
 */
import { isPlainObject } from './validate.ts';
import type { RpcPort } from './ports.ts';

export type QuotaDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly reason: string; readonly retryAfterSeconds: number }
  | { readonly kind: 'error' };

function retryAfter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.ceil(value), 86_400)
    : 60;
}

/** Interprète `{ allowed, reason?, retry_after_seconds? }`. */
export function parseQuotaResponse(data: unknown): QuotaDecision {
  if (!isPlainObject(data) || typeof data['allowed'] !== 'boolean') return { kind: 'error' };
  if (data['allowed']) return { kind: 'allowed' };
  const reason = typeof data['reason'] === 'string' ? data['reason'] : 'rate_limited';
  return { kind: 'denied', reason, retryAfterSeconds: retryAfter(data['retry_after_seconds']) };
}

/** `consume_ai_quota(p_user, p_prompt_chars)` : quota coach IA (utilisateur + global). */
export async function consumeAiQuota(
  rpc: RpcPort,
  userId: string,
  promptChars: number,
): Promise<QuotaDecision> {
  try {
    const { data, error } = await rpc.rpc('consume_ai_quota', {
      p_user: userId,
      p_prompt_chars: promptChars,
    });
    return error ? { kind: 'error' } : parseQuotaResponse(data);
  } catch {
    return { kind: 'error' };
  }
}

/** `consume_rate_limit(p_scope, p_subject, p_limit, p_window_seconds)` : fenêtre fixe. */
export async function consumeRateLimit(
  rpc: RpcPort,
  scope: string,
  subject: string,
  limit: number,
  windowSeconds: number,
): Promise<QuotaDecision> {
  try {
    const { data, error } = await rpc.rpc('consume_rate_limit', {
      p_scope: scope,
      p_subject: subject,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    return error ? { kind: 'error' } : parseQuotaResponse(data);
  } catch {
    return { kind: 'error' };
  }
}
