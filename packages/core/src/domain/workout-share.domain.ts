/**
 * Workout Share — encodage compact d'un template pour partage via URL.
 *
 * Format (v1) — JSON minifié + base64url, préfixé de la version :
 *   "v1.<base64url-json>"
 *
 * Le payload est volontairement minimal pour tenir dans une URL de taille
 * raisonnable (< 2 KB en pratique) :
 *   { n: name, e: [{i: exerciseId, s: sets, r: targetReps, p: targetRpe}, ...] }
 *
 * On NE met PAS le nom de l'exercice — l'app destinataire résout l'id en
 * cherchant dans son propre catalogue (les exercices Kinetic ont des IDs
 * stables). Si l'id est inconnu, on retombe sur l'id comme nom à l'import.
 *
 * Pur, isomorphe Node/browser. Utilise btoa/atob qui sont disponibles dans
 * les deux environnements (Node 16+).
 */

export interface SharedWorkout {
  name: string;
  exercises: Array<{
    exerciseId: string;
    sets: number;
    targetReps: number;
    targetRpe: number;
  }>;
}

interface SharedWorkoutWire {
  n: string;
  e: Array<{ i: string; s: number; r: number; p: number }>;
}

const VERSION_PREFIX = 'v1.';

/**
 * encodeWorkout — sérialise + base64url + préfixe. Renvoie le token sans
 * embarquer d'URL (l'appelant décide où le placer : query string, hash, etc.).
 */
export function encodeWorkout(workout: SharedWorkout): string {
  const wire: SharedWorkoutWire = {
    n: workout.name,
    e: workout.exercises.map((ex) => ({
      i: ex.exerciseId,
      s: ex.sets,
      r: ex.targetReps,
      p: ex.targetRpe,
    })),
  };
  const json = JSON.stringify(wire);
  const b64 = base64urlEncode(json);
  return `${VERSION_PREFIX}${b64}`;
}

/**
 * decodeWorkout — retourne null si le token est invalide ou d'une version
 * inconnue (pas de throw — l'appelant peut décider quoi afficher).
 */
export function decodeWorkout(token: string): SharedWorkout | null {
  if (typeof token !== 'string' || !token.startsWith(VERSION_PREFIX)) return null;
  const b64 = token.slice(VERSION_PREFIX.length);
  let json: string;
  try {
    json = base64urlDecode(b64);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const wire = parsed as Partial<SharedWorkoutWire>;
  if (typeof wire.n !== 'string' || !Array.isArray(wire.e)) return null;

  const exercises = wire.e
    .filter((ex): ex is SharedWorkoutWire['e'][number] => {
      return Boolean(ex) && typeof ex === 'object' && typeof ex.i === 'string';
    })
    .map((ex) => ({
      exerciseId: ex.i,
      sets: clampInt(ex.s, 1, 20, 3),
      targetReps: clampInt(ex.r, 1, 50, 8),
      targetRpe: clampNum(ex.p, 6, 10, 8),
    }));

  if (exercises.length === 0) return null;

  return {
    name: wire.n.slice(0, 80),
    exercises,
  };
}

/** buildShareUrl — produit l'URL absolue prête à partager. */
export function buildShareUrl(origin: string, token: string): string {
  const trimmed = origin.replace(/\/$/, '');
  return `${trimmed}/?import=${encodeURIComponent(token)}`;
}

// ─── Helpers base64url ───────────────────────────────────────────────────────

function base64urlEncode(input: string): string {
  // btoa accepte une string mais erre sur les caractères >0xFF — on encode UTF-8.
  const utf8 = encodeURIComponent(input).replace(/%([0-9A-F]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  // Re-padding multiple of 4
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  // Re-décoder l'UTF-8
  const escaped = binary
    .split('')
    .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  return decodeURIComponent(escaped);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
