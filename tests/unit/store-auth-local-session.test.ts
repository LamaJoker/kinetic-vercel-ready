/**
 * Store auth : démarrage sur la session LOCALE (sans réseau) et déconnexion avec
 * modifications non synchronisées (docs/architecture/sync.md § 4.1, § 4.5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@kinetic/adapters-web', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
  getAuthUser: vi.fn(),
  getLocalSessionUser: vi.fn(),
  signInWithEmail: vi.fn(),
  signInWithGitHub: vi.fn(),
  signInWithGoogle: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
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
  pendingAfterFlush: vi.fn().mockResolvedValue(0),
}));

import { authStore } from '../../apps/web/src/stores/auth.js';
import { getAuthUser, getLocalSessionUser, signOut, supabase } from '@kinetic/adapters-web';
import { flushAndResetDeps, pendingAfterFlush } from '../../apps/web/src/deps.js';

const LOCAL = { id: 'u1', email: 'a@kinetic.app', full_name: 'A', avatar_url: null };

describe('authStore — session locale', () => {
  const dispatchFn = vi.fn();
  const location = { href: '/' };

  beforeEach(() => {
    vi.clearAllMocks();
    (supabase as any).auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    vi.mocked(getLocalSessionUser).mockReturnValue(LOCAL);
    vi.stubGlobal('window', { dispatchEvent: dispatchFn, location });
    location.href = '/';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auth-ready est émis AVANT la réponse réseau (premier écran sans attente)', async () => {
    let resolveUser!: (u: unknown) => void;
    vi.mocked(getAuthUser).mockReturnValue(
      new Promise((r) => {
        resolveUser = r as (u: unknown) => void;
      }) as never,
    );
    const store = authStore();
    const init = store.init();
    await Promise.resolve();
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    expect(store.user).toMatchObject({ id: 'u1' });
    expect(store.loading).toBe(false);
    resolveUser({ ...LOCAL, full_name: 'A (à jour)' });
    await init;
    expect(store.user).toMatchObject({ full_name: 'A (à jour)' });
    expect(dispatchFn).toHaveBeenCalledTimes(1); // une seule fois
  });

  it('hors-ligne (getAuthUser → null) : la session locale reste, pas de passage en invité', async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const store = authStore();
    await store.init();
    expect(store.user).toMatchObject({ id: 'u1' });
    expect(store.isGuest).toBe(false);
  });

  it('erreur réseau pendant la validation : la session locale reste', async () => {
    vi.mocked(getAuthUser).mockRejectedValue(new Error('fetch failed'));
    const store = authStore();
    await store.init();
    expect(store.user).toMatchObject({ id: 'u1' });
    expect(store.error).toBe('fetch failed');
  });

  it('événement de session hors-ligne : l utilisateur vient de la session, pas de null', async () => {
    vi.mocked(getAuthUser).mockResolvedValue(LOCAL);
    const store = authStore();
    await store.init();
    const cb = (supabase as any).auth.onAuthStateChange.mock.calls[0][0];
    vi.mocked(getAuthUser).mockResolvedValueOnce(null);
    await cb('TOKEN_REFRESHED', { user: { id: 'u1', email: 'a@kinetic.app', user_metadata: {} } });
    expect(store.user).toMatchObject({ id: 'u1', email: 'a@kinetic.app' });
  });
});

describe('authStore — déconnexion avec modifications en attente', () => {
  const location = { href: '/' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), location });
    location.href = '/';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rien en attente : déconnexion directe', async () => {
    vi.mocked(pendingAfterFlush).mockResolvedValue(0);
    const store = authStore();
    await store.logout();
    expect(signOut).toHaveBeenCalled();
    expect(location.href).toBe('/login');
  });

  it('modifications non envoyées : confirmation demandée, pas de déconnexion', async () => {
    vi.mocked(pendingAfterFlush).mockResolvedValue(3);
    const store = authStore();
    await store.logout();
    expect(signOut).not.toHaveBeenCalled();
    expect(store.showLogoutWarning).toBe(true);
    expect(store.logoutWarningText).toBe(
      '3 modifications ne sont pas encore enregistrées dans le cloud.',
    );
    store.cancelLogout();
    expect(store.showLogoutWarning).toBe(false);
    expect(location.href).toBe('/');
  });

  it('« Se déconnecter quand même » : déconnexion, les données restent dans la base du compte', async () => {
    vi.mocked(pendingAfterFlush).mockResolvedValue(1);
    const store = authStore();
    await store.logout();
    expect(store.logoutWarningText).toBe(
      '1 modification n’est pas encore enregistrée dans le cloud.',
    );
    await store.forceLogout();
    expect(flushAndResetDeps).toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
    expect(location.href).toBe('/login');
  });
});
