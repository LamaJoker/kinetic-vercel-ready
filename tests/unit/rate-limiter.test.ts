/**
 * tests/unit/rate-limiter.test.ts
 *
 * Unit tests for packages/adapter-web/src/supabase/RateLimiter.ts.
 * Tests the AuthRateLimiter class directly (not the singleton).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthRateLimiter } from '../../packages/adapter-web/src/supabase/RateLimiter.js';

describe('AuthRateLimiter', () => {
  let limiter: AuthRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new AuthRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── magic link ─────────────────────────────────────────────────────────────

  describe('canSendMagicLink / recordMagicLink', () => {
    it('allows the first request for a fresh email', () => {
      expect(limiter.canSendMagicLink('user@test.com')).toBe(true);
    });

    it('allows up to 3 attempts within the window', () => {
      for (let i = 0; i < 3; i++) {
        expect(limiter.canSendMagicLink('user@test.com')).toBe(true);
        limiter.recordMagicLink('user@test.com');
      }
    });

    it('blocks after 3 recorded attempts', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      expect(limiter.canSendMagicLink('user@test.com')).toBe(false);
    });

    it('is scoped per email address', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('a@test.com');
      expect(limiter.canSendMagicLink('a@test.com')).toBe(false);
      expect(limiter.canSendMagicLink('b@test.com')).toBe(true);
    });

    it('resets after the 5-minute window expires', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      expect(limiter.canSendMagicLink('user@test.com')).toBe(false);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(limiter.canSendMagicLink('user@test.com')).toBe(true);
    });

    it('does NOT reset before the window expires', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(limiter.canSendMagicLink('user@test.com')).toBe(false);
    });
  });

  // ── getWaitTimeMs ──────────────────────────────────────────────────────────

  describe('getWaitTimeMs', () => {
    it('returns 0 when under the limit', () => {
      expect(limiter.getWaitTimeMs('user@test.com')).toBe(0);
    });

    it('returns 0 when only 2 of 3 attempts are used', () => {
      limiter.recordMagicLink('user@test.com');
      limiter.recordMagicLink('user@test.com');
      expect(limiter.getWaitTimeMs('user@test.com')).toBe(0);
    });

    it('returns positive ms when at the limit', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      const wait = limiter.getWaitTimeMs('user@test.com');
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(5 * 60 * 1000);
    });

    it('decreases as time advances', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      const wait1 = limiter.getWaitTimeMs('user@test.com');
      vi.advanceTimersByTime(60_000);
      const wait2 = limiter.getWaitTimeMs('user@test.com');
      expect(wait2).toBeLessThan(wait1);
    });
  });

  // ── OAuth ──────────────────────────────────────────────────────────────────

  describe('canOAuth / recordOAuth', () => {
    it('allows the first OAuth attempt', () => {
      expect(limiter.canOAuth()).toBe(true);
    });

    it('allows up to 10 OAuth attempts within the window', () => {
      for (let i = 0; i < 10; i++) {
        expect(limiter.canOAuth()).toBe(true);
        limiter.recordOAuth();
      }
    });

    it('blocks after 10 OAuth attempts', () => {
      for (let i = 0; i < 10; i++) limiter.recordOAuth();
      expect(limiter.canOAuth()).toBe(false);
    });

    it('resets after the 1-minute window expires', () => {
      for (let i = 0; i < 10; i++) limiter.recordOAuth();
      expect(limiter.canOAuth()).toBe(false);

      vi.advanceTimersByTime(60_000 + 1);
      expect(limiter.canOAuth()).toBe(true);
    });

    it('OAuth and magic-link limits are independent', () => {
      for (let i = 0; i < 3; i++) limiter.recordMagicLink('user@test.com');
      // OAuth should still work
      expect(limiter.canOAuth()).toBe(true);
    });
  });
});
