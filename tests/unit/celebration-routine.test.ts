import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(),
}));

import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../../apps/web/src/deps.js';
import { vitaliteStore } from '../../apps/web/src/stores/vitalite.js';
import {
  InMemoryStorage,
  FakeClock,
  SequentialIdGenerator,
  SpyNotifier,
} from '../helpers/stubs.js';

/** Célébration « routine du jour à 100 % » (stores/vitalite.ts → lib/celebration.ts). */
describe('vitalite : célébration de la routine complète', () => {
  let dispatchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue({
      storage: new InMemoryStorage(),
      clock: new FakeClock('2026-05-12'),
      idGen: new SequentialIdGenerator(),
      notifier: new SpyNotifier(),
    } as never);
    dispatchFn = vi.fn();
    vi.stubGlobal('window', {
      dispatchEvent: dispatchFn,
      Alpine: { store: () => ({ reload: vi.fn().mockResolvedValue(undefined) }) },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const celebrations = () =>
    dispatchFn.mock.calls
      .map(([e]) => e as CustomEvent)
      .filter((e) => e.type === STORAGE_KEYS.EVENT_CELEBRATE)
      .map((e) => e.detail as { kind: string; subtitle: string });

  it('une seule fois, quand la dernière tâche est cochée à la main', async () => {
    const store = vitaliteStore();
    await store.init();
    const ids = store.tasks.map((t) => t.id);
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids.slice(0, -1)) await store.complete(id);
    expect(celebrations()).toHaveLength(0);
    await store.complete(ids[ids.length - 1]!);
    expect(celebrations()).toEqual([
      expect.objectContaining({
        kind: 'routine',
        subtitle: `${ids.length} sur ${ids.length} · 100\u00a0%`,
      }),
    ]);
  });

  it('rien si la dernière tâche est cochée automatiquement (santé)', async () => {
    const store = vitaliteStore();
    await store.init();
    for (const t of store.tasks) await store.complete(t.id, false);
    expect(celebrations()).toHaveLength(0);
  });
});
