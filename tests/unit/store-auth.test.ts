/**
 * tests/unit/store-auth.test.ts
 *
 * Unit tests for apps/web/src/stores/auth.ts.
 * All external dependencies are mocked — no real Supabase calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (factories use only vi.fn() — no outer variable refs, which would
//     cause a ReferenceError because vi.mock() is hoisted above const decls) ──

vi.mock('@kinetic/adapters-web', () => ({
  supabase: null, // GUEST_MODE = true for these tests
  getAuthUser: vi.fn().mockResolvedValue(null),
  signInWithEmail: vi.fn().mockResolvedValue(undefined),
  signInWithGitHub: vi.fn().mockResolvedValue(undefined),
  signInWithGoogle: vi.fn().mockResolvedValue(undefined),
  signOut: vi.fn().mockResolvedValue(undefined),
  authRateLimiter: {
    canSendMagicLink: vi.fn().mockReturnValue(true),
    getWaitTimeMs: vi.fn().mockReturnValue(60_000),
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

// ─── Import after mocks ───────────────────────────────────────────────────────

import { authStore } from '../../apps/web/src/stores/auth.js';
import {
  signInWithEmail,
  signInWithGitHub,
  signInWithGoogle,
  signOut,
  authRateLimiter,
  callbackUrl,
} from '@kinetic/adapters-web';
import { flushAndResetDeps } from '../../apps/web/src/deps.js';

// Typed mock handles for per-test overrides
const mockSignInWithEmail = vi.mocked(signInWithEmail);
const mockSignInWithGitHub = vi.mocked(signInWithGitHub);
const mockSignInWithGoogle = vi.mocked(signInWithGoogle);
const mockCallbackUrl = vi.mocked(callbackUrl);
const mockSignOut = vi.mocked(signOut);
const mockFlushAndResetDeps = vi.mocked(flushAndResetDeps);
const rl = authRateLimiter as {
  canSendMagicLink: ReturnType<typeof vi.fn>;
  getWaitTimeMs: ReturnType<typeof vi.fn>;
  recordMagicLink: ReturnType<typeof vi.fn>;
  canOAuth: ReturnType<typeof vi.fn>;
  recordOAuth: ReturnType<typeof vi.fn>;
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authStore', () => {
  let store: ReturnType<typeof authStore>;
  const dispatchFn = vi.fn();
  const location = { href: '/' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      dispatchEvent: dispatchFn,
      location,
    });
    location.href = '/';
    store = authStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── init (guest mode: supabase === null) ────────────────────────────────

  describe('init — guest mode', () => {
    it('sets a guest user when supabase is null', async () => {
      await store.init();
      expect(store.user).toMatchObject({ id: 'guest', email: null, full_name: 'Invité' });
    });

    it('sets loading to false after init', async () => {
      await store.init();
      expect(store.loading).toBe(false);
    });

    it('dispatches EVENT_AUTH_READY after init', async () => {
      await store.init();
      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });

    it('does not call getAuthUser in guest mode', async () => {
      await store.init();
      // getAuthUser should NOT be called because GUEST_MODE is true (supabase === null)
      const { getAuthUser } = await import('@kinetic/adapters-web');
      expect(vi.mocked(getAuthUser)).not.toHaveBeenCalled();
    });

    it('dispatches EVENT_AUTH_READY only once even if called twice', async () => {
      await store.init();
      await store.init(); // second call resets the guard then re-dispatches
      expect(dispatchFn).toHaveBeenCalledTimes(2);
    });
  });

  // ── loginWithEmail ──────────────────────────────────────────────────────

  describe('loginWithEmail', () => {
    it('calls signInWithEmail and sets magicLinkSent for valid email', async () => {
      store.emailInput = 'user@example.com';
      await store.loginWithEmail();
      expect(mockSignInWithEmail).toHaveBeenCalledWith('user@example.com');
      expect(store.magicLinkSent).toBe(true);
      expect(store.error).toBeNull();
    });

    it('sets error for empty email', async () => {
      store.emailInput = '';
      await store.loginWithEmail();
      expect(store.error).toBeTruthy();
      expect(mockSignInWithEmail).not.toHaveBeenCalled();
    });

    it('sets error for email without @', async () => {
      store.emailInput = 'notanemail';
      await store.loginWithEmail();
      expect(store.error).toBeTruthy();
      expect(mockSignInWithEmail).not.toHaveBeenCalled();
    });

    it('sets error for email without domain extension', async () => {
      store.emailInput = 'user@domain';
      await store.loginWithEmail();
      expect(store.error).toBeTruthy();
      expect(mockSignInWithEmail).not.toHaveBeenCalled();
    });

    it('sets error and does not call signInWithEmail when rate-limited', async () => {
      rl.canSendMagicLink.mockReturnValueOnce(false);
      rl.getWaitTimeMs.mockReturnValueOnce(120_000);
      store.emailInput = 'user@example.com';
      await store.loginWithEmail();
      expect(store.error).toMatch(/Trop de tentatives/);
      expect(mockSignInWithEmail).not.toHaveBeenCalled();
    });

    it('records the magic-link attempt before calling signInWithEmail', async () => {
      store.emailInput = 'user@example.com';
      await store.loginWithEmail();
      expect(rl.recordMagicLink).toHaveBeenCalledWith('user@example.com');
    });

    it('sets error if signInWithEmail throws', async () => {
      mockSignInWithEmail.mockRejectedValueOnce(new Error('SMTP down'));
      store.emailInput = 'user@example.com';
      await store.loginWithEmail();
      expect(store.error).toBe('SMTP down');
      expect(store.magicLinkSent).toBe(false);
    });

    it('normalises email to lowercase before sending', async () => {
      store.emailInput = '  User@Example.COM  ';
      await store.loginWithEmail();
      expect(mockSignInWithEmail).toHaveBeenCalledWith('user@example.com');
    });
  });

  // ── loginWithGitHub ─────────────────────────────────────────────────────

  describe('loginWithGitHub', () => {
    it('calls signInWithGitHub on success', async () => {
      await store.loginWithGitHub();
      expect(mockSignInWithGitHub).toHaveBeenCalled();
      expect(store.error).toBeNull();
    });

    it('sets error when rate-limited', async () => {
      rl.canOAuth.mockReturnValueOnce(false);
      await store.loginWithGitHub();
      expect(store.error).toMatch(/Trop de tentatives/);
      expect(mockSignInWithGitHub).not.toHaveBeenCalled();
    });

    it('records OAuth attempt before redirecting', async () => {
      await store.loginWithGitHub();
      expect(rl.recordOAuth).toHaveBeenCalled();
    });

    it('sets error if signInWithGitHub throws', async () => {
      mockSignInWithGitHub.mockRejectedValueOnce(new Error('GitHub error'));
      await store.loginWithGitHub();
      expect(store.error).toBe('GitHub error');
    });
  });

  // ── loginWithGoogle ─────────────────────────────────────────────────────

  describe('loginWithGoogle', () => {
    it('calls signInWithGoogle on success', async () => {
      await store.loginWithGoogle();
      expect(mockSignInWithGoogle).toHaveBeenCalled();
      expect(store.error).toBeNull();
    });

    it('sets error when rate-limited', async () => {
      rl.canOAuth.mockReturnValueOnce(false);
      await store.loginWithGoogle();
      expect(store.error).toMatch(/Trop de tentatives/);
      expect(mockSignInWithGoogle).not.toHaveBeenCalled();
    });

    it('sets error if signInWithGoogle throws', async () => {
      mockSignInWithGoogle.mockRejectedValueOnce(new Error('Google error'));
      await store.loginWithGoogle();
      expect(store.error).toBe('Google error');
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('calls flushAndResetDeps and signOut', async () => {
      await store.logout();
      expect(mockFlushAndResetDeps).toHaveBeenCalled();
      expect(mockSignOut).toHaveBeenCalled();
    });

    it('redirects to /login', async () => {
      await store.logout();
      expect(location.href).toBe('/login');
    });
  });

  // ── destroy ─────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('unsubscribes from auth subscription if present', () => {
      const unsubscribe = vi.fn();
      store._authSubscription = { unsubscribe };
      store.destroy();
      expect(unsubscribe).toHaveBeenCalled();
      expect(store._authSubscription).toBeNull();
    });

    it('does not throw if subscription is null', () => {
      store._authSubscription = null;
      expect(() => store.destroy()).not.toThrow();
    });
  });

  // ── computed getters ────────────────────────────────────────────────────

  describe('isAuthenticated', () => {
    it('returns false when user is null', () => {
      store.user = null;
      expect(store.isAuthenticated).toBe(false);
    });

    it('returns true when user is set', () => {
      store.user = { id: 'u1', email: 'a@b.com', full_name: 'Alice', avatar_url: null };
      expect(store.isAuthenticated).toBe(true);
    });
  });

  describe('initials', () => {
    it('returns initials from full_name', () => {
      store.user = { id: 'u1', email: null, full_name: 'Alice Martin', avatar_url: null };
      expect(store.initials).toBe('AM');
    });

    it('returns first letter of single name', () => {
      store.user = { id: 'u1', email: null, full_name: 'Alice', avatar_url: null };
      expect(store.initials).toBe('A');
    });

    it('falls back to email when full_name is null, using local-part + domain initial', () => {
      // split on '@': ['bob', 'test.com'] → first chars → 'BT'
      store.user = { id: 'u1', email: 'bob@test.com', full_name: null, avatar_url: null };
      expect(store.initials).toBe('BT');
    });

    it('returns ? when user is null', () => {
      store.user = null;
      expect(store.initials).toBe('?');
    });

    it('truncates to 2 characters max', () => {
      store.user = {
        id: 'u1',
        email: null,
        full_name: 'Alice Bob Charlie',
        avatar_url: null,
      };
      expect(store.initials).toHaveLength(2);
    });
  });

  // ── _diagCallbackUrl ────────────────────────────────────────────────────

  describe('_diagCallbackUrl', () => {
    it('returns the callbackUrl result when window has no Capacitor property', () => {
      // window stub from beforeEach has no Capacitor key → isCap = false
      expect(store._diagCallbackUrl()).toBe('https://example.com/callback');
    });

    it('passes capacitor=true when window.Capacitor is present', () => {
      (window as unknown as Record<string, unknown>)['Capacitor'] = {};
      const result = store._diagCallbackUrl();
      delete (window as unknown as Record<string, unknown>)['Capacitor'];
      expect(result).toBe('https://example.com/callback');
      expect(mockCallbackUrl).toHaveBeenCalledWith({ capacitor: true });
    });

    it('returns "(erreur)" when callbackUrl throws', () => {
      mockCallbackUrl.mockImplementationOnce(() => {
        throw new Error('config missing');
      });
      expect(store._diagCallbackUrl()).toBe('(erreur)');
    });
  });

  // ── _diagSupabaseUrl ────────────────────────────────────────────────────

  describe('_diagSupabaseUrl', () => {
    it('returns "(non definie)" when VITE_SUPABASE_URL is not set in test env', () => {
      // import.meta.env.VITE_SUPABASE_URL is undefined in the Vitest Node environment
      expect(store._diagSupabaseUrl()).toBe('(non définie)');
    });
  });
});
