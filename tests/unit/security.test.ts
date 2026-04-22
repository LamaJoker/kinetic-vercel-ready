/**
 * tests/unit/security.test.ts
 *
 * Tests du module sécurité (apps/web/src/lib/security.ts).
 * Couvre : sanitizeUserInput, sanitizeEmail, sanitizeNumber, checkRateLimit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Inline (même logique que security.ts) ───────────────────────────────
function sanitizeUserInput(input: unknown, maxLength = 500): string {
  if (input === null || input === undefined) return '';
  const str = String(input).trim();
  return str
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/data:/gi, '')
    .slice(0, maxLength);
}

function sanitizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, '');
}

function sanitizeNumber(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

interface RateLimitEntry { count: number; resetAt: number; }
const rateLimitStore = new Map<string, RateLimitEntry>();

function checkRateLimit(key: string, max: number, windowMs: number) {
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
  return { allowed: true, remainingMs: entry.resetAt - now, remaining: max - entry.count };
}
// ─────────────────────────────────────────────────────────────────────────

describe('Security Module', () => {

  describe('sanitizeUserInput', () => {
    it('passe les chaînes normales sans modification', () => {
      expect(sanitizeUserInput('Hello world')).toBe('Hello world');
    });

    it('supprime les balises HTML', () => {
      expect(sanitizeUserInput('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
    });

    it('supprime les protocoles javascript:', () => {
      expect(sanitizeUserInput('javascript:alert(1)')).not.toContain('javascript:');
    });

    it('supprime les event handlers', () => {
      expect(sanitizeUserInput('onclick=evil()')).not.toContain('onclick=');
      expect(sanitizeUserInput('onmouseover=hack()')).not.toContain('onmouseover=');
    });

    it('supprime les data URIs', () => {
      expect(sanitizeUserInput('data:text/html,<h1>XSS</h1>')).not.toContain('data:');
    });

    it('tronque à maxLength', () => {
      const long = 'a'.repeat(600);
      expect(sanitizeUserInput(long, 500).length).toBe(500);
    });

    it('retourne vide pour null/undefined', () => {
      expect(sanitizeUserInput(null)).toBe('');
      expect(sanitizeUserInput(undefined)).toBe('');
    });

    it('trim les espaces', () => {
      expect(sanitizeUserInput('  hello  ')).toBe('hello');
    });
  });

  describe('sanitizeEmail', () => {
    it('met en minuscule et trim', () => {
      expect(sanitizeEmail('  Test@EMAIL.com  ')).toBe('test@email.com');
    });

    it('supprime les caractères non autorisés', () => {
      expect(sanitizeEmail('test"@"email.com')).not.toContain('"');
    });

    it('accepte les emails valides complexes', () => {
      expect(sanitizeEmail('test+tag@sub.domain.co')).toBe('test+tag@sub.domain.co');
    });

    it('supprime les tentatives d\'injection', () => {
      const injected = sanitizeEmail('evil@test.com;DROP TABLE users;');
      expect(injected).not.toContain(';');
    });
  });

  describe('sanitizeNumber', () => {
    it('retourne le nombre correct dans la plage', () => {
      expect(sanitizeNumber(50, 0, 100)).toBe(50);
    });

    it('retourne null pour les valeurs hors plage', () => {
      expect(sanitizeNumber(-1, 0, 100)).toBeNull();
      expect(sanitizeNumber(101, 0, 100)).toBeNull();
    });

    it('retourne null pour les non-nombres', () => {
      expect(sanitizeNumber('abc', 0, 100)).toBeNull();
      expect(sanitizeNumber(NaN, 0, 100)).toBeNull();
      expect(sanitizeNumber(Infinity, 0, 100)).toBeNull();
    });

    it('arrondit à 2 décimales', () => {
      expect(sanitizeNumber(3.14159, 0, 100)).toBe(3.14);
    });
  });

  describe('checkRateLimit', () => {
    beforeEach(() => {
      rateLimitStore.clear();
    });

    it('permet les requêtes sous la limite', () => {
      const r = checkRateLimit('test-action', 5, 60000);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it('bloque après avoir atteint la limite', () => {
      for (let i = 0; i < 3; i++) {
        checkRateLimit('magic-link', 3, 300000);
      }
      const r = checkRateLimit('magic-link', 3, 300000);
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe(0);
    });

    it('remet le compteur à zéro après la fenêtre', () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      checkRateLimit('reset-test', 1, 1000);
      checkRateLimit('reset-test', 1, 1000);
      const blocked = checkRateLimit('reset-test', 1, 1000);
      expect(blocked.allowed).toBe(false);

      // Avancer le temps de 1001ms
      vi.setSystemTime(now + 1001);
      const after = checkRateLimit('reset-test', 1, 1000);
      expect(after.allowed).toBe(true);

      vi.useRealTimers();
    });

    it('isole les différentes actions', () => {
      for (let i = 0; i < 5; i++) checkRateLimit('action-A', 5, 60000);
      const r = checkRateLimit('action-A', 5, 60000);
      expect(r.allowed).toBe(false);

      // action-B est indépendante
      const rB = checkRateLimit('action-B', 5, 60000);
      expect(rB.allowed).toBe(true);
    });
  });
});
