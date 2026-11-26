/**
 * Données personnelles et secrets hors des journaux et des webhooks.
 *
 * - `redactSensitive` masque e-mails, jetons (JWT, Bearer, clés API),
 *   longues chaînes aléatoires, numéros de téléphone, identifiants UUID et
 *   paramètres de requête d'URL ;
 * - `hmacHex` produit un pseudonyme stable (HMAC-SHA-256) d'une IP ou d'un
 *   identifiant : on peut compter ou limiter sans stocker la valeur brute ;
 * - `createLogger` n'écrit que des événements structurés dont chaque champ
 *   texte est masqué et borné.
 */
import { stripControlChars, truncate } from './validate.ts';

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWT (trois segments base64url, en-tête commençant par eyJ)
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[jeton]'],
  // En-tête Authorization recopié dans un message
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [jeton]'],
  // Clés API connues (Anthropic, Stripe, GitHub, Supabase…)
  [/\b(sk-ant-|sk_live_|sk_test_|rk_live_|ghp_|gho_|github_pat_|sbp_)[A-Za-z0-9_-]{8,}/g, '[clé]'],
  // E-mails
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g, '[e-mail]'],
  // Paires « clé=valeur » sensibles hors URL (token=…, password: …)
  [
    /\b(token|access_token|refresh_token|password|passwd|secret|apikey|api_key|code)(\s*[=:]\s*)[^\s&,;"']+/gi,
    '$1$2[…]',
  ],
  // Paramètres de requête (jetons de lien magique, codes OAuth…)
  [/([?&#][A-Za-z0-9_.-]{1,40}=)[^&#\s"'<>]+/g, '$1[…]'],
  // UUID (identifiants d'utilisateur)
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  // Longues chaînes hexadécimales ou base64 (jetons opaques)
  [/\b[A-Fa-f0-9]{32,}\b/g, '[jeton]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[jeton]'],
  // Numéros de téléphone (international ou 10 chiffres groupés)
  [/(?<![\w.])\+?\d[\d .-]{8,14}\d(?![\w.])/g, '[tél]'],
];

/** Masque les données sensibles puis borne la longueur. */
export function redactSensitive(input: string, maxLength = 500): string {
  let out = stripControlChars(input);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return truncate(out, maxLength);
}

/**
 * Neutralise les mentions de messagerie (`@everyone`, `@here`, `<@123>`) en
 * insérant un caractère de largeur nulle après `@`.
 */
export function neutralizeMentions(input: string): string {
  return input.replace(/@/g, '@​');
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA-256 hexadécimal (64 caractères) de `value` avec `secret`. */
export async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export interface LogSink {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/**
 * Journal structuré (une ligne JSON par événement). Les champs texte sont
 * masqués et bornés à 200 caractères ; les nombres et booléens passent tels quels.
 */
export function createLogger(scope: string, sink: LogSink): Logger {
  return {
    log(level, event, fields = {}) {
      const safe: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        safe[key] = typeof value === 'string' ? redactSensitive(value, 200) : value;
      }
      sink[level](JSON.stringify({ fn: scope, event, ...safe }));
    },
  };
}

/** Message d'une erreur inconnue, masqué (pour un journal). */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redactSensitive(`${err.name}: ${err.message}`, 200);
  return redactSensitive(String(err), 200);
}
