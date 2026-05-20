/**
 * tests/unit/store-auth-warnlog.test.ts
 *
 * Tests for auth.ts lines 38-44 (FIX #4: console.warn when VITE_SUPABASE_URL is
 * configured but the Supabase client is null — likely an invalid API key format).
 *
 * These lines execute at MODULE INIT time; the only way to cover them is to:
 * 1. Stub the env BEFORE importing auth.ts
 * 2. Clear the module cache with vi.resetModules() so auth.ts re-executes from scratch
 * 3. Dynamically import auth.ts inside the test body (after the env is set)
 *
 * Kept in a separate file because:
 * - vi.mock() factories in other auth test files use supabase: null too, but the
 *   VITE_SUPABASE_URL env is not set, so the warn is never triggered there.
 * - Each Vitest test file has its own isolated module registry.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ─── Mocks — supabase=null so GUEST_MODE=true in every import of auth.ts ─────
vi.mock('@kinetic/adapters-web', () => ({
  supabase: null,
  getAuthUser: vi.fn().mockResolvedValue(null),
  signInWithEmail: vi.fn(),
  signInWithGitHub: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn(),
  authRateLimiter: {
    canSendMagicLink: vi.fn().mockReturnValue(true),
    getWaitTimeMs: vi.fn().mockReturnValue(0),
    recordMagicLink: vi.fn(),
    canOAuth: vi.fn().mockReturnValue(true),
    recordOAuth: vi.fn(),
  },
  callbackUrl: vi.fn().mockReturnValue('https://example.com/callback'),
}));

vi.mock('../../apps/web/src/deps.js', () => ({
  flushAndResetDeps: vi.fn().mockResolvedValue(undefined),
  resetDeps: vi.fn(),
}));

// ─── Cleanup after every test ─────────────────────────────────────────────────
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('auth.ts — FIX #4 console.warn for invalid Supabase key (lines 40-44)', () => {
  it('logs a [auth] warning when VITE_SUPABASE_URL is a real URL but client is null (covers lines 40-44)', async () => {
    // Set SUPABASE_URL to a real-looking URL (not placeholder) — triggers the warn
    vi.stubEnv('VITE_SUPABASE_URL', 'https://real-project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'bad-key-not-jwt-format');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Clear cache so auth.ts module-level code runs fresh with the stubbed env
    vi.resetModules();
    const { authStore } = await import('../../apps/web/src/stores/auth.js');

    // The console.warn at lines 40-44 should have fired
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).toContain('[auth]');
    expect(warnCalls).toContain('Supabase');

    // authStore is still exported and functional despite the warning
    expect(typeof authStore).toBe('function');

    warnSpy.mockRestore();
  });

  it('does NOT warn when SUPABASE_URL contains the placeholder sentinel', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://xxxxxxxxxxxxxxxxxxxx.supabase.co');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.resetModules();
    await import('../../apps/web/src/stores/auth.js');

    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).not.toContain('[auth]');

    warnSpy.mockRestore();
  });

  it('does NOT warn when VITE_SUPABASE_URL is not set (undefined/empty)', async () => {
    // Don't stub VITE_SUPABASE_URL — it stays undefined
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.resetModules();
    await import('../../apps/web/src/stores/auth.js');

    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).not.toContain('[auth]');

    warnSpy.mockRestore();
  });
});
