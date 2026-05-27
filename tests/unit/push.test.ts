/**
 * Tests pour la lib push. On stub navigator.serviceWorker, Notification,
 * et les Service Worker registration + PushManager.
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  } as Storage;
}

// ─── Stub Notification + navigator + window ──────────────────────────────
type NotifPerm = 'granted' | 'denied' | 'default';
let notifPermission: NotifPerm = 'granted';
const requestPermissionMock = vi.fn(async () => notifPermission);

function buildSwReg(opts: {
  existingSub?: unknown;
  subscribeReturn?: unknown;
  subscribeThrows?: boolean;
}) {
  return {
    pushManager: {
      async getSubscription() {
        return opts.existingSub ?? null;
      },
      async subscribe() {
        if (opts.subscribeThrows) throw new Error('subscribe failed');
        return opts.subscribeReturn;
      },
    },
  };
}

function installBrowserStubs(swReg: unknown): void {
  (globalThis as Record<string, unknown>).Notification = class {
    static permission: NotifPerm = notifPermission;
    static requestPermission = requestPermissionMock;
  };
  (globalThis as Record<string, unknown>).PushManager = class {};
  (globalThis as Record<string, unknown>).window = {
    PushManager: class {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      userAgent: 'test-ua',
      serviceWorker: {
        ready: Promise.resolve(swReg),
      },
    },
  });
}

function uninstallBrowserStubs(): void {
  delete (globalThis as Record<string, unknown>).Notification;
  delete (globalThis as Record<string, unknown>).PushManager;
  (globalThis as Record<string, unknown>).window = globalThis;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { userAgent: 'test' },
  });
}

vi.mock('@kinetic/adapters-web', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: vi.fn(() => ({
      upsert: vi.fn(async () => ({ data: null })),
      delete: vi.fn(() => ({ eq: vi.fn(async () => ({ data: null })) })),
    })),
  },
}));

beforeAll(() => {
  vi.stubEnv(
    'VITE_VAPID_PUBLIC_KEY',
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
  notifPermission = 'granted';
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallBrowserStubs();
});

describe('push lib', () => {
  it('getPushStatus retourne unsupported sans navigator.serviceWorker', async () => {
    (globalThis as Record<string, unknown>).window = undefined;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { userAgent: 'test' },
    });
    delete (globalThis as Record<string, unknown>).Notification;
    const { getPushStatus } = await import('../../apps/web/src/lib/push.js');
    const s = getPushStatus();
    expect(s.supported).toBe(false);
    expect(s.permission).toBe('unsupported');
  });

  it('getPushStatus retourne supported + permission granted en env complet', async () => {
    installBrowserStubs(buildSwReg({}));
    const { getPushStatus } = await import('../../apps/web/src/lib/push.js');
    const s = getPushStatus();
    expect(s.supported).toBe(true);
    expect(s.permission).toBe('granted');
    expect(s.subscribed).toBe(false);
  });

  it('isPushAvailable retourne true avec env VAPID + browser OK', async () => {
    installBrowserStubs(buildSwReg({}));
    const { isPushAvailable } = await import('../../apps/web/src/lib/push.js');
    expect(isPushAvailable()).toBe(true);
  });

  it('isPushAvailable retourne false si VAPID absent', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
    vi.resetModules();
    installBrowserStubs(buildSwReg({}));
    const { isPushAvailable } = await import('../../apps/web/src/lib/push.js');
    expect(isPushAvailable()).toBe(false);
    vi.stubEnv(
      'VITE_VAPID_PUBLIC_KEY',
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    );
  });

  it('enablePush retourne null si permission refusée', async () => {
    notifPermission = 'default';
    requestPermissionMock.mockResolvedValueOnce('denied');
    installBrowserStubs(buildSwReg({}));
    const { enablePush } = await import('../../apps/web/src/lib/push.js');
    const result = await enablePush();
    expect(result).toBeNull();
  });

  it("enablePush retourne null si permission est 'denied' (sans appel requestPermission)", async () => {
    notifPermission = 'denied';
    installBrowserStubs(buildSwReg({}));
    const { enablePush } = await import('../../apps/web/src/lib/push.js');
    const result = await enablePush();
    expect(result).toBeNull();
  });

  it('enablePush utilise la subscription existante sans re-subscribe', async () => {
    const existing = {
      endpoint: 'https://fcm.example/abc',
      keys: { p256dh: 'p256', auth: 'aaa' },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    installBrowserStubs(buildSwReg({ existingSub: existing }));
    const { enablePush } = await import('../../apps/web/src/lib/push.js');
    const result = await enablePush();
    expect(result?.endpoint).toBe('https://fcm.example/abc');
    expect(localStorage.getItem('kinetic:push:subscription')).toContain('https://fcm.example/abc');
  });

  it('enablePush crée une nouvelle subscription si aucune existante', async () => {
    const newSub = {
      endpoint: 'https://fcm.example/new',
      keys: { p256dh: 'p2', auth: 'a2' },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    installBrowserStubs(buildSwReg({ existingSub: null, subscribeReturn: newSub }));
    const { enablePush } = await import('../../apps/web/src/lib/push.js');
    const result = await enablePush();
    expect(result?.endpoint).toBe('https://fcm.example/new');
  });

  it('enablePush retourne null si subscribe throws', async () => {
    installBrowserStubs(buildSwReg({ subscribeThrows: true }));
    const { enablePush } = await import('../../apps/web/src/lib/push.js');
    const result = await enablePush();
    expect(result).toBeNull();
  });

  it('disablePush révoque + nettoie localStorage', async () => {
    const sub = {
      endpoint: 'https://fcm.example/abc',
      keys: { p256dh: 'x', auth: 'y' },
      unsubscribe: vi.fn(async () => true),
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    localStorage.setItem('kinetic:push:subscription', '{}');
    installBrowserStubs(buildSwReg({ existingSub: sub }));
    const { disablePush } = await import('../../apps/web/src/lib/push.js');
    const ok = await disablePush();
    expect(ok).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem('kinetic:push:subscription')).toBeNull();
  });

  it('disablePush sans navigator.serviceWorker retourne false', async () => {
    (globalThis as Record<string, unknown>).navigator = { userAgent: 'test' };
    const { disablePush } = await import('../../apps/web/src/lib/push.js');
    const ok = await disablePush();
    expect(ok).toBe(false);
  });
});
