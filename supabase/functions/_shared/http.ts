/**
 * Utilitaires HTTP purs : réponses JSON, lecture bornée du corps, extraction
 * du jeton Bearer. Aucun parse avant que la taille ne soit vérifiée.
 */

/** En-têtes ajoutés à toute réponse JSON. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, ...BASE_HEADERS },
  });
}

/** Réponse d'erreur au format commun `{ error, message }` (message en français). */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
  extra: Readonly<Record<string, unknown>> = {},
): Response {
  return jsonResponse(status, { ...extra, error, message }, headers);
}

export type BodyResult =
  | { readonly ok: true; readonly value: unknown; readonly bytes: number }
  | {
      readonly ok: false;
      readonly status: 400 | 411 | 413 | 415;
      readonly error: string;
      readonly message: string;
    };

export interface ReadJsonOptions {
  /** Taille maximale du corps en octets. */
  readonly maxBytes: number;
  /** Refuser (411) une requête sans `Content-Length`. */
  readonly requireContentLength: boolean;
}

const TOO_LARGE = {
  ok: false,
  status: 413,
  error: 'payload_too_large',
  message: 'Requête trop volumineuse.',
} as const;

/** `application/json` (paramètre `charset=utf-8` toléré), rien d'autre. */
export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const [type, ...params] = value.split(';').map((p) => p.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => p === '' || p === 'charset=utf-8');
}

/**
 * Contrôle des en-têtes SANS lire le corps : type de contenu, présence et
 * valeur de `Content-Length`. Renvoie `null` si tout va bien.
 */
export function checkBodyHeaders(
  req: Request,
  options: ReadJsonOptions,
): Exclude<BodyResult, { ok: true }> | null {
  if (!isJsonContentType(req.headers.get('content-type'))) {
    return {
      ok: false,
      status: 415,
      error: 'unsupported_media_type',
      message: 'Le corps doit être du JSON (Content-Type: application/json).',
    };
  }
  const declared = req.headers.get('content-length');
  if (declared === null) {
    if (options.requireContentLength) {
      return {
        ok: false,
        status: 411,
        error: 'length_required',
        message: 'En-tête Content-Length requis.',
      };
    }
    return null;
  }
  if (!/^\d{1,12}$/.test(declared.trim())) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_content_length',
      message: 'En-tête Content-Length invalide.',
    };
  }
  if (Number(declared) > options.maxBytes) return TOO_LARGE;
  return null;
}

/**
 * Lit au plus `limit` octets du flux. Au-delà, la lecture s'arrête et le flux
 * est annulé : un corps énorme (ou un `Content-Length` mensonger) n'est jamais
 * chargé en mémoire.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Lecture stricte d'un corps JSON : en-têtes, lecture bornée (min de la
 * limite et du `Content-Length` annoncé), UTF-8 strict, puis `JSON.parse`.
 */
export async function readJsonBody(req: Request, options: ReadJsonOptions): Promise<BodyResult> {
  const headerError = checkBodyHeaders(req, options);
  if (headerError) return headerError;
  const declared = req.headers.get('content-length');
  const limit = declared === null ? options.maxBytes : Math.min(options.maxBytes, Number(declared));
  const read = await readBounded(req.body, limit);
  if (!read.ok) return TOO_LARGE;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  } catch {
    return { ok: false, status: 400, error: 'invalid_json', message: 'Corps JSON invalide.' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown, bytes: read.bytes.byteLength };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json', message: 'Corps JSON invalide.' };
  }
}

/** Jeton de l'en-tête `Authorization: Bearer <jeton>`, ou `null`. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,4096})$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Comparaison en temps constant (longueur comprise dans la boucle) pour les
 * secrets partagés.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i += 1) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/**
 * Exécute `fn` avec un signal d'annulation déclenché après `ms` millisecondes.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
