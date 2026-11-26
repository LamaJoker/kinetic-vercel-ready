/**
 * Outils JSON purs pour la fusion de synchronisation : égalité profonde
 * indépendante de l'ordre des clés et sérialisation stable (identité d'élément).
 *
 * Les valeurs synchronisées sont du JSON (StoragePort) : pas de Date, Map, classes.
 * `undefined` dans un objet est traité comme une propriété absente (comme JSON.stringify).
 */

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sérialisation stable : clés d'objet triées, `undefined` ignoré dans les objets. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    // NaN/Infinity deviennent null comme en JSON.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  const obj = value as JsonObject;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Égalité profonde de valeurs JSON (ordre des clés d'objet indifférent, ordre des tableaux significatif). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return stableStringify(a) === stableStringify(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  return stableStringify(a) === stableStringify(b);
}

/** Lecture d'un chemin pointé (`food.name`) dans une valeur JSON. */
export function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}
