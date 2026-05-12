import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('offlineStore', () => {
  let listeners: Map<string, Set<Function>>;

  beforeEach(() => {
    listeners = new Map();
    vi.useFakeTimers();

    const fakeWindow = {
      addEventListener: (type: string, fn: Function) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: Function) => {
        listeners.get(type)?.delete(fn);
      },
    };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', { onLine: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('reflects initial navigator.onLine state (online)', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    expect(store.isOffline).toBe(false);
    expect(store.wasOffline).toBe(false);
  });

  it('reflects initial navigator.onLine state (offline)', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    expect(store.isOffline).toBe(true);
    expect(store.lastOnlineAt).toBeNull();
  });

  it('init registers online and offline event listeners', async () => {
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    store.init();
    expect(listeners.has('online')).toBe(true);
    expect(listeners.has('offline')).toBe(true);
  });

  it('switches to offline when offline event fires', async () => {
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    store.init();
    listeners.get('offline')?.forEach((fn) => fn());
    expect(store.isOffline).toBe(true);
  });

  it('switches to online when online event fires', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    store.isOffline = true;
    store.init();
    listeners.get('online')?.forEach((fn) => fn());
    expect(store.isOffline).toBe(false);
    expect(store.sinceSecs).toBe(0);
  });

  it('destroy clears the timer', async () => {
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    store.init();
    expect(() => store.destroy()).not.toThrow();
  });

  it('sets wasOffline=true then clears after 3s when coming back online', async () => {
    const { offlineStore } = await import('../../apps/web/src/stores/offline.js');
    const store = offlineStore();
    store.isOffline = true;
    store.init();
    listeners.get('online')?.forEach((fn) => fn());
    expect(store.wasOffline).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(store.wasOffline).toBe(false);
  });
});
