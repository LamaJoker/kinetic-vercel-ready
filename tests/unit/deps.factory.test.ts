/**
 * createDepsManager — choix de la base locale SANS réseau (session locale), une base
 * par compte, repli sur l'ancienne base si la base du compte est inutilisable.
 *
 * Mise à jour délibérée (sync.md § 4.1/4.5) : l'ancienne interface (getAuthUser réseau
 * avec timeout + createHybridStorage(local, remote)) est remplacée par
 * getSessionUserId (lecture locale) + openStorage(owner). Chaque comportement couvert
 * auparavant reste couvert : local sans cloud, base synchronisée + démarrage quand un
 * compte existe, injection de test, flush avalé, repli en cas d'échec, abandon d'une
 * construction en cours, flush avant reset, promesse partagée, dispose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDepsManager,
  type DepsFactoryOptions,
  type FlushableStorage,
} from '../../apps/web/src/deps.factory.js';
import {
  FakeClock,
  InMemoryStorage,
  SequentialIdGenerator,
  SpyNotifier,
} from '@test-helpers/stubs.ts';

function options(overrides: Partial<DepsFactoryOptions> = {}): DepsFactoryOptions {
  return {
    createLocalStorage: () => new InMemoryStorage(),
    createClock: () => new FakeClock(),
    createIdGen: () => new SequentialIdGenerator(),
    createNotifier: () => new SpyNotifier(),
    createNoopDailyLogSync: () => ({ upsert: vi.fn() }),
    createDailyLogSync: () => ({ upsert: vi.fn() }),
    hasRemoteSync: true,
    getSessionUserId: () => 'u1',
    openStorage: async () => new InMemoryStorage(),
    ...overrides,
  };
}

function syncedStub(): InMemoryStorage &
  Required<Pick<FlushableStorage, 'flushPendingWrites' | 'start' | 'dispose'>> {
  return Object.assign(new InMemoryStorage(), {
    flushPendingWrites: vi.fn(async () => undefined),
    start: vi.fn(),
    dispose: vi.fn(),
  });
}

describe('createDepsManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sans cloud configuré : base invité, même si une session existe', async () => {
    const openStorage = vi.fn(async () => new InMemoryStorage());
    const manager = createDepsManager(options({ hasRemoteSync: false, openStorage }));
    const deps = await manager.getDeps();
    // 2e argument ajouté (reprise des écritures d'un repli) : aucun repli mémorisé ici.
    expect(openStorage).toHaveBeenCalledWith('guest', { recoverFallbackWrites: false });
    expect(deps.owner).toBe('guest');
    expect(deps.storage).toBeInstanceOf(InMemoryStorage);
  });

  it('session locale présente : base du compte, synchro démarrée, journal quotidien distant', async () => {
    const synced = syncedStub();
    const remoteLog = { upsert: vi.fn() };
    const onStorageReady = vi.fn((s: FlushableStorage) => s.start?.());
    const manager = createDepsManager(
      options({
        openStorage: async (owner) => {
          expect(owner).toBe('u1');
          return synced;
        },
        createDailyLogSync: () => remoteLog,
        onStorageReady,
      }),
    );
    const deps = await manager.getDeps();
    expect(deps.storage).toBe(synced);
    expect(deps.owner).toBe('u1');
    expect(deps.dailyLogSync).toBe(remoteLog);
    expect(onStorageReady).toHaveBeenCalledWith(synced, 'u1');
    expect(synced.start).toHaveBeenCalled();
    expect(manager.currentOwner()).toBe('u1');
  });

  it('aucune session : base invité', async () => {
    const openStorage = vi.fn(async () => new InMemoryStorage());
    const manager = createDepsManager(options({ getSessionUserId: () => null, openStorage }));
    expect((await manager.getDeps()).owner).toBe('guest');
    // 2e argument ajouté (reprise des écritures d'un repli) : aucun repli mémorisé ici.
    expect(openStorage).toHaveBeenCalledWith('guest', { recoverFallbackWrites: false });
  });

  it('aucun appel réseau : seule la session locale est lue (getSessionUserId synchrone)', async () => {
    const getSessionUserId = vi.fn(() => 'u1');
    const manager = createDepsManager(options({ getSessionUserId }));
    await manager.getDeps();
    expect(getSessionUserId).toHaveBeenCalled();
    expect(manager.desiredOwner()).toBe('u1');
  });

  it('setDepsForTesting injecte des deps et getDeps les retourne immédiatement', async () => {
    const manager = createDepsManager(options());
    const mockDeps = {
      storage: new InMemoryStorage(),
      clock: new FakeClock(),
      idGen: new SequentialIdGenerator(),
      notifier: new SpyNotifier(),
      dailyLogSync: { upsert: vi.fn() },
    };
    manager.setDepsForTesting(mockDeps as any);
    const deps = await manager.getDeps();
    expect(deps.storage).toBe(mockDeps.storage);
  });

  it('flushAndResetDeps avale les erreurs de flushPendingWrites', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const synced = Object.assign(syncedStub(), {
      flushPendingWrites: vi.fn().mockRejectedValue(new Error('network lost during flush')),
    });
    const manager = createDepsManager(options({ openStorage: async () => synced }));
    await manager.getDeps();
    await expect(manager.flushAndResetDeps()).resolves.toBeUndefined();
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('[deps]');
  });

  it('base du compte inutilisable (propriétaire différent, IDB en panne) : repli sur l ancienne base', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = new InMemoryStorage();
    const manager = createDepsManager(
      options({
        createLocalStorage: () => legacy,
        openStorage: async () => {
          throw new Error('OwnerMismatchError');
        },
      }),
    );
    const deps = await manager.getDeps();
    expect(deps.storage).toBe(legacy);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('[deps]');
  });

  it('IndexedDB sans réponse (IdbUnresponsiveError) : AUCUN repli vers une base vide, erreur remontée et signalée', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marks = new Set<string>();
    const createLocalStorage = vi.fn(() => new InMemoryStorage());
    const onStorageUnresponsive = vi.fn();
    const stuck = Object.assign(new Error('[idb] ouverture : IndexedDB ne répond pas'), {
      name: 'IdbUnresponsiveError',
    });
    const manager = createDepsManager(
      options({
        createLocalStorage,
        fallbackMarks: marks,
        onStorageUnresponsive,
        openStorage: async () => {
          throw stuck;
        },
      }),
    );
    await expect(manager.getDeps()).rejects.toBe(stuck);
    // Pas de repli (il montrerait une base vide), pas de mémo de repli, rien en cache.
    expect(createLocalStorage).not.toHaveBeenCalled();
    expect(marks.size).toBe(0);
    expect(manager.currentOwner()).toBeNull();
    expect(onStorageUnresponsive).toHaveBeenCalledTimes(1);
    expect(onStorageUnresponsive).toHaveBeenCalledWith(stuck);
  });

  it('repli mémorisé : la base du compte reprend ensuite les écritures, puis le mémo est effacé', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marks = new Set<string>();
    let fail = true;
    const synced = Object.assign(syncedStub(), { fallbackRecovered: true });
    const openStorage = vi.fn(async () => {
      if (fail) throw new Error('UnknownError');
      return synced;
    });
    const createLocalStorage = vi.fn(() => new InMemoryStorage());
    const first = createDepsManager(
      options({ openStorage, createLocalStorage, fallbackMarks: marks }),
    );
    await first.getDeps();
    expect(createLocalStorage).toHaveBeenCalledWith('u1');
    expect(marks.has('u1')).toBe(true);

    fail = false;
    const second = createDepsManager(options({ openStorage, fallbackMarks: marks }));
    expect((await second.getDeps()).storage).toBe(synced);
    expect(openStorage).toHaveBeenLastCalledWith('u1', { recoverFallbackWrites: true });
    expect(marks.has('u1')).toBe(false);
  });

  it('resetDeps pendant l ouverture : base libérée, rien en cache, nouvelle ouverture ensuite', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = syncedStub();
    const second = syncedStub();
    const opened = [first, second];
    const manager = createDepsManager(
      options({
        openStorage: async () => {
          const s = opened.shift()!;
          if (s === first) await gate;
          return s;
        },
      }),
    );
    const pending = manager.getDeps();
    manager.resetDeps();
    release();
    await pending;
    expect(first.dispose).toHaveBeenCalled();
    expect(manager.currentOwner()).toBeNull();
    expect((await manager.getDeps()).storage).toBe(second);
  });

  it('flushAndResetDeps envoie ce qui attend (sans backoff) puis libère la base', async () => {
    const synced = syncedStub();
    const manager = createDepsManager(options({ openStorage: async () => synced }));
    await manager.getDeps();
    await manager.flushAndResetDeps();
    expect(synced.flushPendingWrites).toHaveBeenCalledWith({ ignoreBackoff: true });
    expect(synced.dispose).toHaveBeenCalledOnce();
    expect(manager.currentOwner()).toBeNull();
  });

  it('appels concurrents : une seule ouverture partagée', async () => {
    const openStorage = vi.fn(async () => new InMemoryStorage());
    const manager = createDepsManager(options({ openStorage }));
    const [d1, d2] = await Promise.all([manager.getDeps(), manager.getDeps()]);
    expect(d1).toBe(d2);
    expect(openStorage).toHaveBeenCalledTimes(1);
  });

  it('changement de compte : la base suit la session locale', async () => {
    let session: string | null = 'u1';
    const openStorage = vi.fn(async () => syncedStub());
    const manager = createDepsManager(options({ getSessionUserId: () => session, openStorage }));
    expect((await manager.getDeps()).owner).toBe('u1');
    session = 'u2';
    expect(manager.desiredOwner()).toBe('u2');
    expect(manager.currentOwner()).toBe('u1');
    await manager.flushAndResetDeps();
    expect((await manager.getDeps()).owner).toBe('u2');
    expect(openStorage.mock.calls.map((c) => c[0])).toEqual(['u1', 'u2']);
  });
});
