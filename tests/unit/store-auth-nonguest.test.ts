/**
 * tests/unit/store-auth-nonguest.test.ts
 *
 * Tests for auth.ts non-guest mode (supabase !== null).
 * A separate file is required because supabase is mocked as non-null here,
 * making GUEST_MODE = false and exercising lines 77-131.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks — supabase is a non-null mock so GUEST_MODE evaluates to false ────

vi.mock('@kinetic/adapters-web', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
  getAuthUser: vi.fn().mockResolvedValue({
    id: 'u1',
    email: 'test@kinetic.app',
    full_name: 'Test User',
    avatar_url: null,
  }),
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

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { authStore } from '../../apps/web/src/stores/auth.js';
import { supabase, getAuthUser } from '@kinetic/adapters-web';
import { resetDeps, flushAndResetDeps } from '../../apps/web/src/deps.js';

// Convenience: typed access to the mocked onAuthStateChange
const mockOnAuthStateChange = () =>
  (supabase as any).auth.onAuthStateChange as ReturnType<typeof vi.fn>;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authStore — non-guest mode (supabase != null)', () => {
  let store: ReturnType<typeof authStore>;
  const dispatchFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore onAuthStateChange default return value after clearAllMocks
    mockOnAuthStateChange().mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    vi.mocked(getAuthUser).mockResolvedValue({
      id: 'u1',
      email: 'test@kinetic.app',
      full_name: 'Test User',
      avatar_url: null,
    });
    vi.stubGlobal('window', { dispatchEvent: dispatchFn });
    store = authStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Basic init behaviour ────────────────────────────────────────────────

  it('calls getAuthUser on init (non-guest)', async () => {
    await store.init();
    expect(vi.mocked(getAuthUser)).toHaveBeenCalled();
  });

  it('sets user from getAuthUser result', async () => {
    await store.init();
    expect(store.user).toMatchObject({ id: 'u1', email: 'test@kinetic.app' });
  });

  it('sets loading=false in finally block', async () => {
    await store.init();
    expect(store.loading).toBe(false);
  });

  it('sets _initDone=true after successful init', async () => {
    await store.init();
    expect(store._initDone).toBe(true);
  });

  it('registers onAuthStateChange listener', async () => {
    await store.init();
    expect(mockOnAuthStateChange()).toHaveBeenCalled();
  });

  it('stores the auth subscription from onAuthStateChange', async () => {
    await store.init();
    expect(store._authSubscription).not.toBeNull();
  });

  it('dispatches EVENT_AUTH_READY after successful init', async () => {
    await store.init();
    expect(dispatchFn).toHaveBeenCalledOnce();
  });

  // ── Error path ──────────────────────────────────────────────────────────

  it('sets error message and guest user when getAuthUser throws', async () => {
    vi.mocked(getAuthUser).mockRejectedValueOnce(new Error('network fail'));
    await store.init();
    expect(store.error).toBe('network fail');
    expect(store.user).toMatchObject({ id: 'guest' });
  });

  it('sets error to generic string when thrown value is not an Error', async () => {
    vi.mocked(getAuthUser).mockRejectedValueOnce('unexpected string');
    await store.init();
    expect(store.error).toBe('Erreur auth');
  });

  it('sets loading=false even when getAuthUser throws', async () => {
    vi.mocked(getAuthUser).mockRejectedValueOnce(new Error('timeout'));
    await store.init();
    expect(store.loading).toBe(false);
  });

  // ── Timeout path ────────────────────────────────────────────────────────

  it('resolves with null user when getAuthUser times out after 8s', async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthUser).mockReturnValue(new Promise(() => {})); // never resolves

    const initPromise = store.init();
    await vi.advanceTimersByTimeAsync(8001);
    await initPromise;

    expect(store.user).toBeNull(); // timeout resolved with null
    expect(store.loading).toBe(false);
    vi.useRealTimers();
  });

  // ── onAuthStateChange callback ──────────────────────────────────────────

  /** Helper: init the store and retrieve the registered callback. */
  async function getCallback() {
    await store.init();
    const cb = mockOnAuthStateChange().mock.calls[0]?.[0] as (
      event: string,
      session: { user?: { id: string } } | null,
    ) => Promise<void>;
    expect(cb).toBeDefined();
    return cb;
  }

  describe('onAuthStateChange callback', () => {
    it('SIGNED_IN: updates user via getAuthUser', async () => {
      const callback = await getCallback();
      vi.mocked(getAuthUser).mockResolvedValueOnce({
        id: 'u2',
        email: 'new@kinetic.app',
        full_name: 'New User',
        avatar_url: null,
      });
      await callback('SIGNED_IN', { user: { id: 'u2' } });
      expect(store.user).toMatchObject({ id: 'u2' });
    });

    it('SIGNED_IN: resets deps when _initDone=false (timeout case)', async () => {
      const callback = await getCallback();
      store._initDone = false; // simulate timeout — init did not complete fully
      vi.mocked(getAuthUser).mockResolvedValueOnce({
        id: 'u1',
        email: 'test@kinetic.app',
        full_name: 'Test User',
        avatar_url: null,
      });
      await callback('SIGNED_IN', { user: { id: 'u1' } });
      expect(vi.mocked(resetDeps)).toHaveBeenCalled();
    });

    it('SIGNED_IN: resets deps when getAuthUser returns null in callback', async () => {
      const callback = await getCallback();
      vi.mocked(getAuthUser).mockResolvedValueOnce(null as any);
      await callback('SIGNED_IN', { user: { id: 'u1' } });
      expect(vi.mocked(resetDeps)).toHaveBeenCalled();
    });

    it('SIGNED_IN: dispatches EVENT_AUTH_CHANGED when authReady already fired', async () => {
      const callback = await getCallback();
      // authReady was dispatched during init — _authReadyDispatched is now true
      dispatchFn.mockClear();
      vi.mocked(getAuthUser).mockResolvedValueOnce({
        id: 'u1',
        email: 'test@kinetic.app',
        full_name: 'Test User',
        avatar_url: null,
      });
      await callback('SIGNED_IN', { user: { id: 'u1' } });
      // EVENT_AUTH_CHANGED should be dispatched
      expect(dispatchFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: expect.stringContaining('auth') }),
      );
    });

    it('SIGNED_OUT: clears user and calls flushAndResetDeps', async () => {
      const callback = await getCallback();
      store.user = { id: 'u1', email: 'test@kinetic.app', full_name: 'Test', avatar_url: null };
      await callback('SIGNED_OUT', null);
      expect(store.user).toBeNull();
      expect(vi.mocked(flushAndResetDeps)).toHaveBeenCalled();
    });

    it('SIGNED_OUT: sets loading=false after handling', async () => {
      const callback = await getCallback();
      store.loading = true;
      await callback('SIGNED_OUT', null);
      expect(store.loading).toBe(false);
    });

    it('TOKEN_REFRESHED without session: sets user to null', async () => {
      const callback = await getCallback();
      store.user = { id: 'u1', email: 'test@kinetic.app', full_name: 'Test', avatar_url: null };
      await callback('TOKEN_REFRESHED', null);
      expect(store.user).toBeNull();
    });

    it('INITIAL_SESSION without session: sets user to null', async () => {
      const callback = await getCallback();
      store.user = { id: 'u1', email: 'test@kinetic.app', full_name: 'Test', avatar_url: null };
      await callback('INITIAL_SESSION', null);
      expect(store.user).toBeNull();
    });

    it('any event: sets loading=false', async () => {
      const callback = await getCallback();
      store.loading = true;
      await callback('TOKEN_REFRESHED', null);
      expect(store.loading).toBe(false);
    });
  });
});
