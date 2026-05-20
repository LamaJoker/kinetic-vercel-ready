import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDepsManager } from '../../apps/web/src/deps.factory.js';
import {
  FakeClock,
  InMemoryStorage,
  SequentialIdGenerator,
  SpyNotifier,
} from '@test-helpers/stubs.ts';

describe('createDepsManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retourne les deps locales si le remote est desactive', async () => {
    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: (local) => local,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => ({ id: 'u1' }),
      hasRemoteSync: false,
      syncTimeoutMs: 100,
    });

    const deps = await manager.getDeps();
    expect(deps.storage).toBeInstanceOf(InMemoryStorage);
  });

  it('reconstruit un storage hybride quand un user distant existe', async () => {
    const local = new InMemoryStorage();
    const remote = new InMemoryStorage();
    const hybrid = Object.assign(new InMemoryStorage(), {
      flushPendingWrites: vi.fn(),
      syncFromRemote: vi.fn(),
    });

    const manager = createDepsManager({
      createLocalStorage: () => local,
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => remote,
      createHybridStorage: () => hybrid,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => ({ id: 'u1' }),
      hasRemoteSync: true,
      syncTimeoutMs: 100,
      onHybridReady: (storage) => {
        void storage.syncFromRemote?.();
      },
    });

    const deps = await manager.getDeps();
    expect(deps.storage).toBe(hybrid);
    expect(hybrid.syncFromRemote).toHaveBeenCalled();
  });

  it('setDepsForTesting injecte des deps pour les tests et getDeps les retourne immédiatement (covers lines 131-132)', async () => {
    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: (local) => local,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => null,
      hasRemoteSync: false,
      syncTimeoutMs: 100,
    });

    const mockDeps = {
      storage: new InMemoryStorage(),
      clock: new FakeClock(),
      idGen: new SequentialIdGenerator(),
      notifier: new SpyNotifier(),
      dailyLogSync: { upsert: vi.fn() },
    };

    manager.setDepsForTesting(mockDeps as any);
    const deps = await manager.getDeps();
    // Should return the injected mock deps immediately (without hitting remote)
    expect(deps.storage).toBe(mockDeps.storage);
  });

  it('flushAndResetDeps swallows flushPendingWrites errors (covers lines 123-124)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hybrid = Object.assign(new InMemoryStorage(), {
      flushPendingWrites: vi.fn().mockRejectedValue(new Error('network lost during flush')),
    });

    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: () => hybrid,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => ({ id: 'u1' }),
      hasRemoteSync: true,
      syncTimeoutMs: 100,
    });

    await manager.getDeps();
    // Should NOT throw — catch block swallows the error and logs a warning
    await expect(manager.flushAndResetDeps()).resolves.toBeUndefined();
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('[deps]');
    consoleSpy.mockRestore();
  });

  it('falls back to local storage when getAuthUser throws (covers lines 93-94)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = new InMemoryStorage();

    const manager = createDepsManager({
      createLocalStorage: () => local,
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: (l) => l,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => {
        throw new Error('auth service unavailable');
      },
      hasRemoteSync: true,
      syncTimeoutMs: 5000,
    });

    const deps = await manager.getDeps();
    // Error swallowed — falls back to local storage
    expect(deps.storage).toBe(local);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('[deps]');
    consoleSpy.mockRestore();
  });

  it('returns local storage early when resetDeps aborts an in-flight getDeps (covers lines 82-83)', async () => {
    let resolveAuth!: (val: { id: string } | null) => void;
    const authDelay = new Promise<{ id: string } | null>((r) => {
      resolveAuth = r;
    });

    const local = new InMemoryStorage();
    const manager = createDepsManager({
      createLocalStorage: () => local,
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: (l) => l,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: () => authDelay,
      hasRemoteSync: true,
      syncTimeoutMs: 10000, // long timeout — won't fire naturally
    });

    // Start getDeps (will block on authDelay)
    const depsPromise = manager.getDeps();

    // Abort by calling resetDeps BEFORE authDelay resolves
    manager.resetDeps();

    // Now resolve auth — ctrl.signal.aborted is already true
    resolveAuth({ id: 'u1' });

    const deps = await depsPromise;
    // Early return at lines 82-83: storage is local, not hybrid
    expect(deps.storage).toBe(local);
  });

  it('flushAndResetDeps appelle le flush si disponible', async () => {
    const hybrid = Object.assign(new InMemoryStorage(), {
      flushPendingWrites: vi.fn(async () => undefined),
    });

    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: () => hybrid,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => ({ id: 'u1' }),
      hasRemoteSync: true,
      syncTimeoutMs: 100,
    });

    await manager.getDeps();
    await manager.flushAndResetDeps();
    expect(hybrid.flushPendingWrites).toHaveBeenCalled();
  });

  it('concurrent getDeps calls share the same inflight promise (covers line 64: if(inflight) branch)', async () => {
    let callCount = 0;
    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: (l) => l,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => {
        callCount++;
        return { id: 'u1' };
      },
      hasRemoteSync: true,
      syncTimeoutMs: 100,
    });

    // Two concurrent calls — second should share the inflight promise (line 64)
    const [d1, d2] = await Promise.all([manager.getDeps(), manager.getDeps()]);
    expect(d1).toBe(d2); // same object reference
    expect(callCount).toBe(1); // getAuthUser only called once
  });

  it('flushAndResetDeps calls dispose() when available (covers line 126 branch)', async () => {
    const disposeSpy = vi.fn();
    const hybrid = Object.assign(new InMemoryStorage(), {
      flushPendingWrites: vi.fn(async () => undefined),
      dispose: disposeSpy,
    });

    const manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
      createRemoteStorage: () => new InMemoryStorage(),
      createHybridStorage: () => hybrid,
      createDailyLogSync: () => ({ upsert: vi.fn() }),
      getAuthUser: async () => ({ id: 'u1' }),
      hasRemoteSync: true,
      syncTimeoutMs: 100,
    });

    await manager.getDeps();
    await manager.flushAndResetDeps();
    // dispose() should have been called on the hybrid storage
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});
