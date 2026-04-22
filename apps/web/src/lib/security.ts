/**
 * apps/web/src/lib/security.ts
 *
 * Module sécurité centralisé.
 * Gère : CSP, sanitization des entrées, rate limiting côté client.
 */

// ─── Content Security Policy ──────────────────────────────────

export const CSP_DIRECTIVES = {
  'default-src':              ["'self'"],
  'script-src':               ["'self'"],
  'style-src':                ["'self'", "'unsafe-inline'"], // Alpine inline attrs
  'img-src':                  ["'self'", 'data:', 'https:'],
  'font-src':                 ["'self'", 'data:'],
  'connect-src':              ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
  'frame-src':                ["'none'"],
  'object-src':               ["'none'"],
  'base-uri':                 ["'self'"],
  'form-action':              ["'self'"],
  'frame-ancestors':          ["'none'"],
  'upgrade-insecure-requests': [],
} as const;

export function buildCSPString(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) =>
      (sources as readonly string[]).length > 0
        ? `${directive} ${(sources as readonly string[]).join(' ')}`
        : directive
    )
    .join('; ');
}

// ─── Input Sanitization ───────────────────────────────────────

/**
 * sanitizeUserInput — nettoie les entrées utilisateur avant stockage.
 * Élimine les vecteurs XSS courants.
 */
export function sanitizeUserInput(input: unknown, maxLength = 500): string {
  if (input === null || input === undefined) return '';
  const str = String(input).trim();

  return str
    .replace(/[<>]/g, '')           // Pas de balises HTML
    .replace(/javascript:/gi, '')   // Pas de protocole JS
    .replace(/on\w+\s*=/gi, '')     // Pas d'event handlers inline
    .replace(/data:/gi, '')         // Pas de data URIs
    .slice(0, maxLength);
}

export function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, '');
}

export function sanitizeNumber(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

// ─── Rate Limiter client-side ─────────────────────────────────

interface RateLimitEntry {
  count:   number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * checkRateLimit — empêche le spam d'actions (magic link, form submit…).
 */
export function checkRateLimit(
  key:      string,
  max:      number,
  windowMs: number,
): { allowed: boolean; remainingMs: number; remaining: number } {
  const now   = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remainingMs: windowMs, remaining: max - 1 };
  }

  if (entry.count >= max) {
    return { allowed: false, remainingMs: entry.resetAt - now, remaining: 0 };
  }

  entry.count++;
  return {
    allowed:      true,
    remainingMs:  entry.resetAt - now,
    remaining:    max - entry.count,
  };
}

// ─── Storage validation ───────────────────────────────────────

export function validateStorageKey(key: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,200}$/.test(key);
}

export function validateStorageValue(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 1_024 * 1_024; // 1MB max
  } catch {
    return false;
  }
}

// ─── Secure Headers (référence pour vercel.json) ─────────────

export const SECURE_HEADERS = {
  'X-Content-Type-Options':  'nosniff',
  'X-Frame-Options':         'DENY',
  'X-XSS-Protection':        '0',  // CSP est préféré
  'Referrer-Policy':         'strict-origin-when-cross-origin',
  'Permissions-Policy':      'camera=(), microphone=(), geolocation=(self), notifications=(self)',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
} as const;
