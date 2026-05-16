import { describe, it, expect, vi, afterEach } from 'vitest';

describe('getOrCreateDeviceId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns server fallback ID when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id = getOrCreateDeviceId();
    expect(id).toMatch(/^server-/);
  });

  it('generates and persists a UUID on first call', async () => {
    const store: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    vi.stubGlobal('window', { localStorage: fakeLocalStorage }); // ensures typeof window !== 'undefined'
    vi.stubGlobal('localStorage', fakeLocalStorage);
    vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });

    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id = getOrCreateDeviceId();
    expect(id).toBe('test-uuid-1234');
  });

  it('returns the same ID on subsequent calls (persisted)', async () => {
    const store: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    vi.stubGlobal('window', { localStorage: fakeLocalStorage });
    vi.stubGlobal('localStorage', fakeLocalStorage);
    vi.stubGlobal('crypto', { randomUUID: () => 'persistent-uuid' });

    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id1 = getOrCreateDeviceId();
    const id2 = getOrCreateDeviceId();
    expect(id1).toBe(id2);
  });

  it('returns a volatile UUID when localStorage throws (private mode)', async () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('QuotaExceededError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    vi.stubGlobal('window', { localStorage: throwingStorage });
    vi.stubGlobal('localStorage', throwingStorage);
    vi.stubGlobal('crypto', { randomUUID: () => 'volatile-fallback-id' });

    const { getOrCreateDeviceId } = await import('../../apps/web/src/lib/sync.js');
    const id = getOrCreateDeviceId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});
