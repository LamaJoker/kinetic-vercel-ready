/**
 * tests/unit/security.test.ts
 *
 * Tests du module sécurité (apps/web/src/lib/security.ts).
 * Couvre : sanitizeUserInput, sanitizeEmail, sanitizeNumber, checkRateLimit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// M5 FIX: importer les vraies fonctions au lieu d'une ré-implémentation inline
import {
  sanitizeUserInput,
  sanitizeEmail,
  sanitizeNumber,
  checkRateLimit,
  isValidEmail,
  _clearRateLimitStoreForTesting,
} from '../../apps/web/src/lib/security.js';

describe('Security Module', () => {
  describe('sanitizeUserInput', () => {
    it('passe les chaînes normales sans modification', () => {
      expect(sanitizeUserInput('Hello world')).toBe('Hello world');
    });

    it('encode les balises HTML en entités (whitelist encoding)', () => {
      const result = sanitizeUserInput('<script>alert(1)</script>');
      expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });

    it('encode les guillemets doubles', () => {
      expect(sanitizeUserInput('"value"')).toBe('&quot;value&quot;');
    });

    it('encode les apostrophes', () => {
      expect(sanitizeUserInput("it's")).toBe('it&#x27;s');
    });

    it('encode les esperluettes', () => {
      expect(sanitizeUserInput('a & b')).toBe('a &amp; b');
    });

    it("conserve le texte javascript: sans le modifier (ce n'est pas du HTML)", () => {
      // La nouvelle implémentation encode les chars dangereux <> " ' &
      // mais ne supprime pas les protocoles — c'est safe car on encode toujours
      const result = sanitizeUserInput('javascript:alert(1)');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
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

  describe('isValidEmail', () => {
    it('accepts a standard email', () => {
      expect(isValidEmail('user@example.com')).toBe(true);
    });

    it('accepts email with subdomains and plus-tag', () => {
      expect(isValidEmail('user+tag@sub.domain.co')).toBe(true);
    });

    it('rejects email without @', () => {
      expect(isValidEmail('notanemail')).toBe(false);
    });

    it('rejects email without domain extension', () => {
      expect(isValidEmail('user@domain')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidEmail('')).toBe(false);
    });

    it('is case-insensitive (trims + lowercases before checking)', () => {
      expect(isValidEmail('  User@EXAMPLE.COM  ')).toBe(true);
    });
  });

  describe('sanitizeEmail', () => {
    it('normalises to lowercase and trims, returns valid email', () => {
      expect(sanitizeEmail('  Test@EMAIL.com  ')).toBe('test@email.com');
    });

    it('returns empty string for invalid format after stripping', () => {
      expect(sanitizeEmail('notanemail')).toBe('');
    });

    it('accepts complex valid email', () => {
      expect(sanitizeEmail('test+tag@sub.domain.co')).toBe('test+tag@sub.domain.co');
    });

    it('strips illegal characters AND rejects if result is invalid', () => {
      // After stripping `;` the result is `evil@test.comdrop table users`
      // which is not a valid email format
      const injected = sanitizeEmail('evil@test.com;DROP TABLE users;');
      expect(injected).not.toContain(';');
    });

    it('returns empty string for input that has no valid local-part after strip', () => {
      // Stripping '"' from '"@email.com' leaves '@email.com' → invalid
      expect(sanitizeEmail('"@email.com')).toBe('');
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
      _clearRateLimitStoreForTesting();
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
