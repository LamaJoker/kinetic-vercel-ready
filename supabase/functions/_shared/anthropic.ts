/**
 * Appel à l'API Messages d'Anthropic (HTTP brut, sans SDK : aucune dépendance
 * ajoutée) avec délai maximal, modèle et `max_tokens` bornés côté serveur, et
 * traduction des échecs en messages français sans détail interne.
 */
import { readBounded } from './http.ts';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Modèles autorisés ; toute autre valeur de `ANTHROPIC_MODEL` est ignorée. */
export const ALLOWED_MODELS: readonly string[] = [
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-opus-5-5',
  'claude-sonnet-4-6',
];
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 1024;
export const MIN_MAX_TOKENS = 256;
export const MAX_MAX_TOKENS = 2048;
/** Taille maximale lue dans la réponse d'Anthropic. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export function resolveModel(raw: string | undefined): string {
  return raw !== undefined && ALLOWED_MODELS.includes(raw) ? raw : DEFAULT_MODEL;
}

export function resolveMaxTokens(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, n));
}

export interface ClaudeRequest {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly userContent: string;
  readonly timeoutMs: number;
}

export type ClaudeFailure =
  | 'rate_limited'
  | 'overloaded'
  | 'upstream_error'
  | 'config_error'
  | 'timeout'
  | 'network'
  | 'refusal'
  | 'empty'
  | 'invalid_response';

export type ClaudeResult =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly failure: ClaudeFailure; readonly status?: number };

interface MessagesResponse {
  stop_reason?: unknown;
  content?: unknown;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Classe un statut HTTP d'erreur d'Anthropic. */
export function classifyStatus(status: number): ClaudeFailure {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'upstream_error';
  // 400/401/403/404/413 : requête ou configuration du serveur à corriger.
  return 'config_error';
}

export async function callClaude(
  fetchImpl: typeof fetch,
  req: ClaudeRequest,
): Promise<ClaudeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          output_config: { effort: 'low' },
          system: req.system,
          messages: [{ role: 'user', content: req.userContent }],
        }),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, failure: controller.signal.aborted ? 'timeout' : 'network' };
    }
    if (!resp.ok) {
      // Corps d'erreur volontairement ignoré : il peut contenir des détails internes.
      await resp.body?.cancel().catch(() => undefined);
      return { ok: false, failure: classifyStatus(resp.status), status: resp.status };
    }
    let data: MessagesResponse;
    try {
      const read = await readBounded(resp.body, MAX_RESPONSE_BYTES);
      if (!read.ok) return { ok: false, failure: 'invalid_response' };
      data = JSON.parse(new TextDecoder().decode(read.bytes)) as MessagesResponse;
    } catch {
      return { ok: false, failure: controller.signal.aborted ? 'timeout' : 'invalid_response' };
    }
    if (typeof data !== 'object' || data === null)
      return { ok: false, failure: 'invalid_response' };
    if (data.stop_reason === 'refusal') return { ok: false, failure: 'refusal' };
    const text = extractText(data.content);
    if (!text) return { ok: false, failure: 'empty' };
    return { ok: true, text, truncated: data.stop_reason === 'max_tokens' };
  } finally {
    clearTimeout(timer);
  }
}

export interface MappedFailure {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

/** Traduction d'un échec en réponse HTTP pour le client (aucun détail interne). */
export function mapClaudeFailure(failure: ClaudeFailure): MappedFailure {
  switch (failure) {
    case 'rate_limited':
    case 'overloaded':
      return {
        status: 503,
        error: 'ai_busy',
        message: 'Le coach est très sollicité en ce moment. Réessaie dans une minute.',
        retryAfterSeconds: 60,
      };
    case 'timeout':
      return {
        status: 504,
        error: 'ai_timeout',
        message: 'Le coach a mis trop de temps à répondre. Réessaie dans un instant.',
      };
    case 'refusal':
      return {
        status: 422,
        error: 'ai_refused',
        message:
          'Le coach ne peut pas répondre à cette demande. Reformule ta question sur ton entraînement.',
      };
    case 'empty':
    case 'invalid_response':
    case 'upstream_error':
    case 'network':
    case 'config_error':
      return {
        status: 502,
        error: 'ai_unavailable',
        message: 'Le coach est indisponible pour le moment. Réessaie plus tard.',
      };
  }
}
