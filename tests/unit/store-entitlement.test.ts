import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storageMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  keys: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn().mockResolvedValue({ storage: storageMock }),
}));

import { entitlementStore } from '../../apps/web/src/stores/entitlement.js';

describe('entitlementStore', () => {
  let store: ReturnType<typeof entitlementStore>;

  beforeEach(() => {
    store = entitlementStore();
    storageMock.get.mockReset();
    storageMock.set.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it('démarre un essai Pro de 7 jours au premier lancement (rien en stockage)', async () => {
    storageMock.get.mockResolvedValueOnce(null);
    await store.init();
    expect(store.isPro).toBe(true);
    expect(store.isOnTrial).toBe(true);
    expect(store.trialDaysLeft).toBeGreaterThan(0);
    expect(store.trialDaysLeft).toBeLessThanOrEqual(7);
    // persiste l'essai
    expect(storageMock.set).toHaveBeenCalledTimes(1);
  });

  it('charge un entitlement gratuit existant sans rien écrire', async () => {
    storageMock.get.mockResolvedValueOnce({ tier: 'free', trialEndsAt: null, proUntil: null });
    await store.init();
    expect(store.isPro).toBe(false);
    expect(store.tier).toBe('free');
    expect(storageMock.set).not.toHaveBeenCalled();
  });

  it('charge un abonné Pro', async () => {
    storageMock.get.mockResolvedValueOnce({ tier: 'pro', proUntil: null });
    await store.init();
    expect(store.isPro).toBe(true);
    expect(store.can('ai_coach')).toBe(true);
    expect(store.can('nutrition_scanner')).toBe(true);
  });

  it('can() bloque les features Pro en gratuit', async () => {
    storageMock.get.mockResolvedValueOnce({ tier: 'free' });
    await store.init();
    expect(store.can('advanced_analytics')).toBe(false);
    expect(store.can('data_export')).toBe(false);
  });

  it('setTier bascule en Pro et persiste', async () => {
    storageMock.get.mockResolvedValueOnce({ tier: 'free' });
    await store.init();
    await store.setTier('pro');
    expect(store.isPro).toBe(true);
    expect(storageMock.set).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ tier: 'pro' }),
    );
  });

  it('repli gratuit si le stockage échoue', async () => {
    storageMock.get.mockRejectedValueOnce(new Error('IDB down'));
    await store.init();
    expect(store.isPro).toBe(false);
    expect(store.loaded).toBe(true);
  });
});
