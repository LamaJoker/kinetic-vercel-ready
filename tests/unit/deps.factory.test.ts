import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDepsManager } from '../../apps/web/src/deps.factory.js';
import { FakeClock, InMemoryStorage, SequentialIdGenerator, SpyNotifier } from '@test-helpers/stubs.ts';

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
      onHybridReady: (storage) => { void storage.syncFromRemote?.(); },
    });

    const deps = await manager.getDeps();
    expect(deps.storage).toBe(hybrid);
    expect(hybrid.syncFromRemote).toHaveBeenCalled();
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
});
