/**
 * CORS strict des fonctions Edge.
 *
 * Règles :
 * - liste blanche `ALLOWED_ORIGINS` (origines séparées par des virgules) ;
 *   OBLIGATOIRE en production : absente ou vide → toutes les requêtes sont
 *   refusées (503 `cors_not_configured`), jamais d'ouverture à `*` ;
 * - `*` et `null` ne sont jamais acceptés, ni dans la liste ni en réponse ;
 * - origine présente mais non autorisée → 403 sans en-tête CORS ;
 * - requête sans en-tête `Origin` (appel serveur à serveur, application
 *   native sans WebView) : pas d'en-tête CORS, la requête continue (le CORS
 *   ne protège que les navigateurs ; l'authentification reste exigée) ;
 * - hors production (`KINETIC_ENV=development|local|test`) sans liste : seules
 *   les origines de boucle locale `http://localhost[:port]` et
 *   `http://127.0.0.1[:port]` sont acceptées.
 */
import { isProduction, readEnv, type EnvReader } from './env.ts';

export interface CorsConfig {
  /** Origines exactes autorisées (forme `schéma://hôte[:port]`). */
  readonly allowedOrigins: readonly string[];
  readonly production: boolean;
  /** Méthodes annoncées dans la réponse préliminaire. */
  readonly methods: string;
  /** En-têtes annoncés dans la réponse préliminaire. */
  readonly headers: string;
}

export type CorsDecision =
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'ok'; readonly headers: Readonly<Record<string, string>> };

const DEFAULT_HEADERS = 'authorization, content-type, apikey, x-client-info';
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Normalise une origine : `schéma://hôte[:port]`, sans chemin ni barre finale.
 * Renvoie `undefined` pour `*`, `null` ou une valeur qui n'est pas une origine.
 */
export function normalizeOrigin(raw: string): string | undefined {
  const value = raw.trim();
  if (value === '' || value === '*' || value.toLowerCase() === 'null') return undefined;
  // Une origine n'a ni chemin, ni requête, ni identifiants.
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#@\s]+)\/?$/i.exec(value);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  if (host.includes('*')) return undefined;
  return `${scheme}://${host}`;
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const origin = normalizeOrigin(part);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export function loadCorsConfig(
  env: EnvReader,
  options: { methods?: string; headers?: string } = {},
): CorsConfig {
  return {
    allowedOrigins: parseAllowedOrigins(readEnv(env, 'ALLOWED_ORIGINS')),
    production: isProduction(env),
    methods: options.methods ?? 'POST, OPTIONS',
    headers: options.headers ?? DEFAULT_HEADERS,
  };
}

/** Décide du sort d'une requête selon son en-tête `Origin`. */
export function evaluateCors(origin: string | null, config: CorsConfig): CorsDecision {
  if (config.production && config.allowedOrigins.length === 0) return { kind: 'misconfigured' };
  if (origin === null) return { kind: 'ok', headers: { Vary: 'Origin' } };
  const normalized = normalizeOrigin(origin);
  if (!normalized) return { kind: 'forbidden' };
  const allowed =
    config.allowedOrigins.length > 0
      ? config.allowedOrigins.includes(normalized)
      : !config.production && LOOPBACK.test(normalized);
  if (!allowed) return { kind: 'forbidden' };
  return {
    kind: 'ok',
    headers: {
      'Access-Control-Allow-Origin': normalized,
      'Access-Control-Allow-Methods': config.methods,
      'Access-Control-Allow-Headers': config.headers,
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  };
}
