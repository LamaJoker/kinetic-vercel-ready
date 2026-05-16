export { validateStorageKey, validateStorageValue } from '@kinetic/adapters-web';

/**
 * apps/web/src/lib/security.ts
 *
 * Module securite centralise.
 * Gere : CSP, sanitization des entrees, rate limiting cote client.
 */

export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': [],
} as const;

export function buildCSPString(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) =>
      (sources as readonly string[]).length > 0
        ? `${directive} ${(sources as readonly string[]).join(' ')}`
        : directive,
    )
    .join('; ');
}

/**
 * Sanitize a user-supplied string for safe use as text content (never as HTML).
 *
 * Strategy: encode HTML entities so the string is always safe to insert via
 * textContent or as an attribute value. This is a whitelist-output approach
 * rather than a blacklist-strip approach, which is more robust against bypass.
 *
 * IMPORTANT: Never insert the returned string via innerHTML. Use .textContent
 * or setAttribute() instead. If you need to render HTML, use DOMPurify.
 */
export function sanitizeUserInput(input: unknown, maxLength = 500): string {
  if (input === null || input === undefined) return '';
  const str = String(input).trim().slice(0, maxLength);

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function sanitizeEmail(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]/g, '');
}

export function sanitizeNumber(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; remainingMs: number; remaining: number } {
  const now = Date.now();
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
    allowed: true,
    remainingMs: entry.resetAt - now,
    remaining: max - entry.count,
  };
}

export function _clearRateLimitStoreForTesting(): void {
  rateLimitStore.clear();
}

export const SECURE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), notifications=(self)',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
} as const;
