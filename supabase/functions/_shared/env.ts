/**
 * Lecture de la configuration des fonctions Edge.
 *
 * Module pur (aucun import distant, aucun accès à `Deno`) : `index.ts` passe
 * `(name) => Deno.env.get(name)`, les tests passent un objet en mémoire.
 */

/** Accès en lecture aux variables d'environnement. */
export type EnvReader = (name: string) => string | undefined;

/** Construit un lecteur à partir d'un objet (tests, scripts). */
export function envFromRecord(record: Readonly<Record<string, string | undefined>>): EnvReader {
  return (name) => record[name];
}

/** Valeur nettoyée (espaces retirés) ; chaîne vide → `undefined`. */
export function readEnv(env: EnvReader, name: string): string | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

const NON_PRODUCTION = new Set(['development', 'dev', 'local', 'test']);

/**
 * Production par défaut (échec fermé) : seul `KINETIC_ENV` explicitement
 * positionné à `development`, `dev`, `local` ou `test` relâche les contrôles
 * qui dépendent de l'environnement (CORS sans liste blanche).
 */
export function isProduction(env: EnvReader): boolean {
  const value = readEnv(env, 'KINETIC_ENV')?.toLowerCase();
  return value === undefined || !NON_PRODUCTION.has(value);
}

/**
 * Booléen à échec fermé : seule la chaîne exacte `false` (ou `0`, `no`, `off`)
 * désactive ; toute autre valeur, y compris l'absence, vaut `true`.
 */
export function readSecureFlag(env: EnvReader, name: string): boolean {
  const value = readEnv(env, name)?.toLowerCase();
  if (value === undefined) return true;
  return !['false', '0', 'no', 'off'].includes(value);
}
