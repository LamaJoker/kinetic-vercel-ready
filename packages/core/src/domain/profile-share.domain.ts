/**
 * Profile Share — token compact pour partager un "profil athlète" public.
 *
 * Contenu (volontairement minimal et public) :
 *   - Pseudo (libre, défaut "Athlète Kinetic")
 *   - Niveau XP
 *   - Streak courant
 *   - Total séances
 *   - Best lifts : { exerciseId, weightKg, reps, e1rmKg }[] — typiquement les
 *                  "Big Three" (squat, bench, deadlift) mais générique
 *
 * Format (v1) : "kp1.<base64url-json>" — préfixe distinct de `v1.` (workout-share)
 * pour qu'un router puisse facilement distinguer ?import=v1.x d'un ?profile=kp1.x.
 *
 * Pur, isomorphe Node/browser.
 */

export interface ProfileBestLift {
  exerciseId: string;
  weightKg: number;
  reps: number;
  e1rmKg: number;
}

export interface SharedProfile {
  pseudo: string;
  level: number;
  streak: number;
  totalSessions: number;
  bestLifts: ProfileBestLift[];
}

interface SharedProfileWire {
  p: string;
  l: number;
  k: number;
  t: number;
  b: Array<{ i: string; w: number; r: number; e: number }>;
}

const VERSION_PREFIX = 'kp1.';

export function encodeProfile(profile: SharedProfile): string {
  const wire: SharedProfileWire = {
    p: profile.pseudo.slice(0, 32),
    l: Math.max(1, Math.floor(profile.level || 1)),
    k: Math.max(0, Math.floor(profile.streak || 0)),
    t: Math.max(0, Math.floor(profile.totalSessions || 0)),
    b: profile.bestLifts.slice(0, 10).map((lift) => ({
      i: lift.exerciseId,
      w: roundNum(lift.weightKg),
      r: Math.max(1, Math.floor(lift.reps)),
      e: roundNum(lift.e1rmKg),
    })),
  };
  return `${VERSION_PREFIX}${base64urlEncode(JSON.stringify(wire))}`;
}

export function decodeProfile(token: string): SharedProfile | null {
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
  const wire = parsed as Partial<SharedProfileWire>;
  if (typeof wire.p !== 'string') return null;

  const bestLifts: ProfileBestLift[] = Array.isArray(wire.b)
    ? wire.b
        .filter(
          (x): x is SharedProfileWire['b'][number] =>
            Boolean(x) && typeof x === 'object' && typeof x.i === 'string',
        )
        .map((x) => ({
          exerciseId: x.i,
          weightKg: clampNum(x.w, 0, 1500, 0),
          reps: clampInt(x.r, 1, 100, 1),
          e1rmKg: clampNum(x.e, 0, 2000, 0),
        }))
    : [];

  return {
    pseudo: wire.p.slice(0, 32),
    level: clampInt(wire.l, 1, 99, 1),
    streak: clampInt(wire.k, 0, 9999, 0),
    totalSessions: clampInt(wire.t, 0, 99999, 0),
    bestLifts,
  };
}

export function buildProfileShareUrl(origin: string, token: string): string {
  const trimmed = origin.replace(/\/$/, '');
  return `${trimmed}/?profile=${encodeURIComponent(token)}`;
}

// ─── Helpers (dupliqués depuis workout-share pour éviter le couplage) ─────

function roundNum(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function base64urlEncode(input: string): string {
  const utf8 = encodeURIComponent(input).replace(/%([0-9A-F]{2})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return btoa(utf8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const escaped = binary
    .split('')
    .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  return decodeURIComponent(escaped);
}
