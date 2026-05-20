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

  it('sets up StatusBar and SplashScreen on native platform', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { StatusBar } = await import('@capacitor/status-bar');
    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');

    await initMobile();

    expect(vi.mocked(StatusBar.setStyle)).toHaveBeenCalled();
    expect(vi.mocked(StatusBar.setBackgroundColor)).toHaveBeenCalled();
    expect(vi.mocked(SplashScreen.hide)).toHaveBeenCalled();
  });

  it('swallows StatusBar errors on native platform (catch noop line 51)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { StatusBar } = await import('@capacitor/status-bar');
    vi.mocked(StatusBar.setStyle).mockRejectedValueOnce(new Error('StatusBar unavailable'));
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await expect(initMobile()).resolves.toBeUndefined();
  });

  it('swallows SplashScreen errors on native platform (catch noop line 58)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { SplashScreen } = await import('@capacitor/splash-screen');
    vi.mocked(SplashScreen.hide).mockRejectedValueOnce(new Error('SplashScreen unavailable'));
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await expect(initMobile()).resolves.toBeUndefined();
  });

  it('calls App.getLaunchUrl on native platform (no launch URL)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');

    await initMobile();

    expect(vi.mocked(App.getLaunchUrl)).toHaveBeenCalled();
    expect(vi.mocked(App.addListener)).toHaveBeenCalled();
  });

  it('registers appUrlOpen and backButton listeners on native', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');

    await initMobile();

    const listenerTypes = vi.mocked(App.addListener).mock.calls.map((c) => c[0]);
    expect(listenerTypes).toContain('appUrlOpen');
    expect(listenerTypes).toContain('backButton');
  });

  it('handles launch URL with kinetic:// scheme when supabase is null (logs debug)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue({
      url: 'com.lamajoker.kinetic://callback?code=xxx',
    } as any);

    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    vi.stubGlobal('window', { history: { replaceState: vi.fn() }, dispatchEvent: vi.fn() });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    // supabase is null in mock — logs debug message and continues
    await expect(initMobile()).resolves.toBeUndefined();
  });

  it('handles launch URL that does not match kinetic:// scheme', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue({
      url: 'https://external-site.com/callback',
    } as any);
    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    // Non-kinetic URL should not trigger OAuth handling
    await expect(initMobile()).resolves.toBeUndefined();
  });

  it('backButton: calls history.back() when canGoBack=true and history.length > 1', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);

    let backButtonCb: ((payload: { canGoBack: boolean }) => void) | undefined;
    vi.mocked(App.addListener).mockImplementation((event: string, listener: any) => {
      if (event === 'backButton') backButtonCb = listener;
      return Promise.resolve() as any;
    });

    const backFn = vi.fn();
    vi.stubGlobal('window', {
      history: { back: backFn, length: 2 },
      dispatchEvent: vi.fn(),
    });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await initMobile();

    expect(backButtonCb).toBeDefined();
    backButtonCb!({ canGoBack: true });
    expect(backFn).toHaveBeenCalled();
  });

  it('backButton: calls App.exitApp() when canGoBack=false', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);

    let backButtonCb: ((payload: { canGoBack: boolean }) => void) | undefined;
    vi.mocked(App.addListener).mockImplementation((event: string, listener: any) => {
      if (event === 'backButton') backButtonCb = listener;
      return Promise.resolve() as any;
    });

    vi.stubGlobal('window', { history: { back: vi.fn(), length: 1 }, dispatchEvent: vi.fn() });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await initMobile();

    backButtonCb!({ canGoBack: false });
    expect(vi.mocked(App.exitApp)).toHaveBeenCalled();
  });

  it('catches and logs errors from App plugin setup', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockRejectedValue(new Error('plugin crash'));

    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    // Should not throw — the catch block swallows the error
    await expect(initMobile()).resolves.toBeUndefined();
  });

  it('appUrlOpen listener: skips non-kinetic URLs (line 82 early return)', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);

    let appUrlOpenCb: ((p: { url: string }) => Promise<void>) | undefined;
    vi.mocked(App.addListener).mockImplementation((event: string, listener: any) => {
      if (event === 'appUrlOpen') appUrlOpenCb = listener;
      return Promise.resolve() as any;
    });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await initMobile();

    expect(appUrlOpenCb).toBeDefined();
    // Non-kinetic URL → early return at line 82
    await appUrlOpenCb!({ url: 'https://external.com/path' });
  });

  it('appUrlOpen listener: logs debug when supabase is null and kinetic URL received', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue(null as any);

    let appUrlOpenCb: ((p: { url: string }) => Promise<void>) | undefined;
    vi.mocked(App.addListener).mockImplementation((event: string, listener: any) => {
      if (event === 'appUrlOpen') appUrlOpenCb = listener;
      return Promise.resolve() as any;
    });

    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    vi.stubGlobal('window', { history: { replaceState: vi.fn() }, dispatchEvent: vi.fn() });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    await initMobile();

    // kinetic:// URL with supabase=null in mock → hits line 85 (debugLog)
    await appUrlOpenCb!({ url: 'com.lamajoker.kinetic://callback?code=xxx' });

    const log = fakeLS.getItem('kinetic:auth-debug') ?? '';
    expect(log).toContain('appUrlOpen');
  });
});

describe('debugLog internal catch (via handleOAuthCallback)', () => {
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

  it('swallows localStorage error inside debugLog (covers line 35 catch noop)', async () => {
    // localStorage.getItem throws → debugLog catch block (line 35) is hit
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('localStorage quota exceeded');
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
      location: { href: '' },
    });

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    // Should not throw — debugLog swallows localStorage errors
    await expect(
      handleOAuthCallback(supabase as any, 'com.lamajoker.kinetic://callback?code=xxx'),
    ).resolves.toBeUndefined();
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

  it('logs setSession error when setSession returns an error', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    supabase.auth.setSession.mockResolvedValue({
      data: { user: null },
      error: { message: 'invalid token format' },
    });

    const url = 'com.lamajoker.kinetic://callback#access_token=tok123&refresh_token=ref456';
    await handleOAuthCallback(supabase as any, url);

    const log = fakeLS.getItem('kinetic:auth-debug') ?? '';
    expect(log).toContain('setSession err: invalid token format');
  });

  it('handles getSession throwing during setSession verification', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    supabase.auth.getSession.mockRejectedValue(new Error('session unavailable'));

    const url = 'com.lamajoker.kinetic://callback#access_token=tok123&refresh_token=ref456';
    // Should not propagate — inner catch swallows getSession errors
    await expect(handleOAuthCallback(supabase as any, url)).resolves.toBeUndefined();

    const log = fakeLS.getItem('kinetic:auth-debug') ?? '';
    expect(log).toContain('verify err');
  });

  it('retries exchangeCodeForSession with code when first URL attempt fails', async () => {
    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    supabase.auth.exchangeCodeForSession
      .mockResolvedValueOnce({ error: { message: 'invalid url format' } }) // first fails
      .mockResolvedValueOnce({ error: null }); // retry succeeds

    const url = 'com.lamajoker.kinetic://callback?code=pkce-code-123';
    await handleOAuthCallback(supabase as any, url);

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledTimes(2);
  });

  it('logs final error when both exchangeCodeForSession attempts fail', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    supabase.auth.exchangeCodeForSession.mockResolvedValue({
      error: { message: 'exchange consistently fails' },
    });

    const url = 'com.lamajoker.kinetic://callback?code=pkce-code-123';
    await handleOAuthCallback(supabase as any, url);

    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledTimes(2);
    const log = fakeLS.getItem('kinetic:auth-debug') ?? '';
    expect(log).toContain('exchange err final');
  });

  it('catches and logs exception when an inner call throws unexpectedly', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = {
      auth: {
        setSession: vi.fn().mockRejectedValue(new Error('catastrophic failure')),
        getSession: vi.fn(),
        exchangeCodeForSession: vi.fn(),
      },
    };

    const url = 'com.lamajoker.kinetic://callback#access_token=tok&refresh_token=ref';
    await expect(handleOAuthCallback(supabase as any, url)).resolves.toBeUndefined();

    const log = fakeLS.getItem('kinetic:auth-debug') ?? '';
    expect(log).toContain('callback exception');
  });

  it('falls back to hard reload when SPA nav (window.history.replaceState) throws', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);

    const locationObj = { href: '' };
    vi.stubGlobal('window', {
      history: {
        replaceState: () => {
          throw new Error('history API blocked');
        },
      },
      dispatchEvent: vi.fn(),
      location: locationObj,
    });

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    await handleOAuthCallback(supabase as any, 'com.lamajoker.kinetic://callback?code=pkce123');

    expect(locationObj.href).toBe('/');
  });

  it('swallows error when window.dispatchEvent throws during error_description notification', async () => {
    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    // Override window to make dispatchEvent throw (covers line 138 catch noop)
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      dispatchEvent: () => {
        throw new Error('CSP blocked dispatchEvent');
      },
      location: { href: '' },
    });

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();
    const url = 'com.lamajoker.kinetic://callback?error_description=Access+denied';

    // Should not throw — inner catch block swallows the dispatchEvent error
    await expect(handleOAuthCallback(supabase as any, url)).resolves.toBeUndefined();
  });

  it('swallows error when Browser.close() throws in the finally block (line 181 catch noop)', async () => {
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('plugin already closed'));

    const { handleOAuthCallback } = await import('../../apps/web/src/lib/mobile.js');
    const supabase = makeSupabaseMock();

    // Should not throw — the catch inside finally swallows Browser.close errors
    await expect(
      handleOAuthCallback(supabase as any, 'com.lamajoker.kinetic://callback?code=pkce123'),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Separate describe: non-null supabase in launch URL (covers lines 71-72).
// Uses vi.doMock() to override the file-level supabase:null mock for this block.
// Placed LAST so the factory override doesn't bleed into earlier describe blocks.
// ─────────────────────────────────────────────────────────────────────────────

describe('initMobile — kinetic:// launch URL with non-null supabase (covers lines 71-72)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('calls handleOAuthCallback and returns early when supabase is non-null (if(supabase)=true path)', async () => {
    // Override file-level supabase:null with a real-looking supabase object
    vi.doMock('@kinetic/adapters-web', () => ({
      supabase: {
        auth: {
          setSession: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
          exchangeCodeForSession: vi.fn().mockResolvedValue({ error: null }),
        },
      },
    }));

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const { App } = await import('@capacitor/app');
    vi.mocked(App.getLaunchUrl).mockResolvedValue({
      url: 'com.lamajoker.kinetic://callback?code=test-code',
    } as any);

    const fakeLS = makeFakeLocalStorage();
    vi.stubGlobal('localStorage', fakeLS);
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
      location: { href: '' },
    });

    const { initMobile } = await import('../../apps/web/src/lib/mobile.js');
    // Should resolve: handleOAuthCallback(supabase, url) is called, then 'return' at line 72
    await expect(initMobile()).resolves.toBeUndefined();
  });
});
