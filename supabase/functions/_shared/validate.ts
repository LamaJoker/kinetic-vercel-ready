/**
 * Validation stricte des corps JSON : objet simple, clés connues seulement,
 * types et longueurs bornés. Une valeur invalide est REFUSÉE (400), jamais
 * « réparée » silencieusement.
 */

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

export function ok<T>(value: T): Validation<T> {
  return { ok: true, value };
}

export function fail<T = never>(reason: string): Validation<T> {
  return { ok: false, reason };
}

/** Objet JSON « simple » (ni tableau, ni null, prototype standard). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Première clé inconnue, ou `null`. */
export function unknownKey(
  obj: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) return key;
  return null;
}

/**
 * Caractère de contrôle C0/C1 (hors tabulation, saut de ligne, retour chariot).
 * Testé par code de caractère pour éviter une expression régulière de contrôle.
 */
export function isControlCode(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) if (isControlCode(value.charCodeAt(i))) return true;
  return false;
}

/** Remplace les caractères de contrôle par une espace. */
export function stripControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    out += isControlCode(value.charCodeAt(i)) ? ' ' : value[i];
  }
  return out;
}

/** Chaîne de longueur bornée (en points de code), sans caractère de contrôle. */
export function boundedString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): Validation<string> {
  if (typeof value !== 'string') return fail(`${field}: chaîne attendue`);
  const length = [...value].length;
  if (length < min) return fail(`${field}: trop court`);
  if (length > max) return fail(`${field}: trop long`);
  if (hasControlChars(value)) return fail(`${field}: caractères interdits`);
  return ok(value);
}

/** Tronque à `max` points de code (sans couper une paire de substitution). */
export function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Vérifie la profondeur et le nombre de nœuds d'une valeur JSON (protection
 * contre les structures pathologiques avant toute re-sérialisation).
 */
export function jsonShapeWithin(value: unknown, maxDepth: number, maxNodes: number): boolean {
  let nodes = 0;
  const visit = (v: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return false;
    if (Array.isArray(v)) return v.every((x) => visit(x, depth + 1));
    if (typeof v === 'object' && v !== null) {
      return Object.values(v as Record<string, unknown>).every((x) => visit(x, depth + 1));
    }
    return true;
  };
  return visit(value, 0);
}
