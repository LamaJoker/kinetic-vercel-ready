import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Capacitor stubs ──────────────────────────────────────────────────────────
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

// Capacitor plugins are dynamic imports — stub each one
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(), setBackgroundColor: vi.fn() },
  Style: { Dark: 'DARK' },
}));
vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn() },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: vi.fn(async () => null),
    addListener: vi.fn(),
    exitApp: vi.fn(),
  },
}));
vi.mock('@capacitor/browser', () => ({
  Browser: { close: vi.fn() },
}));

// Supabase adapter stub
vi.mock('@kinetic/adapters-web', () => ({
  supabase: null,
}));

import { Capacitor } from '@capacitor/core';

// ─── Fake localStorage ────────────────────────────────────────────────────────
function makeFakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    _store: store,
  };
}

describe('initMobile', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns immediately when not on a native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    const { App } = await import('@capacitor/app');
    await initMobile();
    // No native plugin calls expected on web
    expect(vi.mocked(App.getLaunchUrl)).not.toHaveBeenCalled();
  });

  it('returns immediately when isNativePlatform is false (SSR-like guard)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    // Should resolve without throwing
    await expect(initMobile()).resolves.toBeUndefined();
  });
});

describe('readAuthDebugLog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns empty string when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    const { readAuthDebugLog } = await import('../../apps/web/src/lib/mobile.js');
    expect(readAuthDebugLog()).toBe('');
  });

  it('returns trimmed log when key is present', async () => {
    const fakeLS = makeFakeLocalStorage();
    fakeLS.setItem('kinetic:auth-debug', '  [10:00:00] some log\n');
    vi.stubGlobal('localStorage', fakeLS);
    const { readAuthDebugLog } = await import('../../apps/web/src/lib/mobile.js');
    expect(readAuthDebugLog()).toBe('[10:00:00] some log');
  });

  it('returns empty string when key is absent', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    const { readAuthDebugLog } = await import('../../apps/web/src/lib/mobile.js');
    expect(readAuthDebugLog()).toBe('');
  });
});

describe('clearAuthDebugLog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('removes the debug key from localStorage', async () => {
    const fakeLS = makeFakeLocalStorage();
    fakeLS.setItem('kinetic:auth-debug', 'some log');
    vi.stubGlobal('localStorage', fakeLS);
    const { clearAuthDebugLog } = await import('../../apps/web/src/lib/mobile.js');
    clearAuthDebugLog();
    expect(fakeLS.getItem('kinetic:auth-debug')).toBeNull();
  });

  it('does not throw when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: () => {
        throw new Error('quota exceeded');
      },
    });
    const { clearAuthDebugLog } = await import('../../apps/web/src/lib/mobile.js');
    expect(() => clearAuthDebugLog()).not.toThrow();
  });
});

describe('handleOAuthCallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  function makeSupabaseMock() {
    return {
      auth: {
        setSession: vi.fn(async () => ({ data: { user: { id: 'abc12345' } }, error: null })),
        exchangeCodeForSession: vi.fn(async () => ({ error: null })),
        getSession: vi.fn(async () => ({ data: { session: { user: { id: 'abc12345' } } } })),
      },
    };
  }

  beforeEach(() => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
      location: { href: '' },
      localStorage: fakeLS,
    });
  });

  it('calls setSession for implicit flow URL (#access_token)', async () => {
    const { Browser } = await import('@capacitor/browser');
    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    const url = 'com.lamajoker.kinetic://callback#access_token=tok123&refresh_token=ref456';

    await handleOAuthCallback(supabase as any, url);

    expect(supabase.auth.setSession).toHaveBeenCalledWith({
      access_token: 'tok123',
      refresh_token: 'ref456',
    });
    expect(vi.mocked(Browser.close)).toHaveBeenCalled();
  });

  it('calls exchangeCodeForSession for PKCE flow URL (?code=)', async () => {
    const { Browser } = await import('@capacitor/browser');
    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    const url = 'com.lamajoker.kinetic://callback?code=pkce123';

    await handleOAuthCallback(supabase as any, url);

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalled();
    expect(vi.mocked(Browser.close)).toHaveBeenCalled();
  });

  it('logs and dispatches error notification when provider returns error_description', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    const dispatchSpy = vi.fn();
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      dispatchEvent: dispatchSpy,
      location: { href: '' },
    });
    vi.stubGlobal(
      'CustomEvent',
      class extends Event {
        detail: unknown;
        constructor(type: string, init?: CustomEventInit) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    const url = 'com.lamajoker.kinetic://callback?error_description=Access+denied';

    await handleOAuthCallback(supabase as any, url);

    const calls = dispatchSpy.mock.calls.map((c) => c[0]);
    const notifyCall = calls.find((e) => e.type === 'kinetic:notify');
    expect(notifyCall).toBeDefined();
    expect((notifyCall as CustomEvent).detail.kind).toBe('error');
  });

  it('does not call setSession or exchangeCode when URL has no token or code', async () => {
    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    const url = 'com.lamajoker.kinetic://callback';

    await handleOAuthCallback(supabase as any, url);

    expect(supabase.auth.setSession).not.toHaveBeenCalled();
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
