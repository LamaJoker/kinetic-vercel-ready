/**
 * tests/unit/storage-maintenance.test.ts
 * Couvre la purge des clés journalières > 90 jours.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoragePort } from '@kinetic/core';
import {
  compactStorage,
  formatBytes,
  getStorageUsage,
} from '../../apps/web/src/lib/storage-maintenance';

class InMemoryStorage implements StoragePort {
  private store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('compactStorage', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('supprime les clés vitalite:done > 90 jours', async () => {
    const old = isoDaysAgo(120);
    const recent = isoDaysAgo(30);
    await storage.set(`kinetic:vitalite:done:${old}`, ['t1']);
    await storage.set(`kinetic:vitalite:done:${recent}`, ['t2']);

    const report = await compactStorage(storage);

    expect(report.removedKeys).toBe(1);
    expect(await storage.get(`kinetic:vitalite:done:${old}`)).toBeNull();
    expect(await storage.get(`kinetic:vitalite:done:${recent}`)).not.toBeNull();
  });

  it('supprime les clés xp:earned > 90 jours', async () => {
    const old = isoDaysAgo(100);
    await storage.set(`kinetic:xp:earned:${old}`, { xp: 50 });

    const report = await compactStorage(storage);

    expect(report.removedKeys).toBe(1);
    expect(await storage.get(`kinetic:xp:earned:${old}`)).toBeNull();
  });

  it('ne touche JAMAIS les clés non-journalières', async () => {
    await storage.set('kinetic:training:sessions', [{ id: 's1' }]);
    await storage.set('kinetic:userProfile', { name: 'Val' });
    await storage.set('kinetic:xp', { xp: 500 });
    await storage.set('kinetic:streak', { count: 5 });

    await compactStorage(storage);

    expect(await storage.get('kinetic:training:sessions')).not.toBeNull();
    expect(await storage.get('kinetic:userProfile')).not.toBeNull();
    expect(await storage.get('kinetic:xp')).not.toBeNull();
    expect(await storage.get('kinetic:streak')).not.toBeNull();
  });

  it('idempotent — un 2e appel ne supprime rien de plus', async () => {
    await storage.set(`kinetic:vitalite:done:${isoDaysAgo(120)}`, ['t']);
    await storage.set(`kinetic:vitalite:done:${isoDaysAgo(30)}`, ['t']);

    const r1 = await compactStorage(storage);
    const r2 = await compactStorage(storage);

    expect(r1.removedKeys).toBe(1);
    expect(r2.removedKeys).toBe(0);
  });

  it('ne supprime pas une clé avec date invalide (par sécurité)', async () => {
    await storage.set('kinetic:vitalite:done:not-a-date', ['t']);
    await storage.set('kinetic:vitalite:done:2020', ['t']);

    const report = await compactStorage(storage);

    expect(report.removedKeys).toBe(0);
  });
});

describe('formatBytes', () => {
  it('formate en o, ko, Mo, Go', () => {
    expect(formatBytes(0)).toBe('0 o');
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(2048)).toBe('2.0 ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 Go');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('getStorageUsage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null fields when navigator is undefined', async () => {
    vi.stubGlobal('navigator', undefined);
    const result = await getStorageUsage();
    expect(result).toEqual({ usedBytes: null, quotaBytes: null, percent: null });
  });

  it('returns null fields when navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {});
    const result = await getStorageUsage();
    expect(result).toEqual({ usedBytes: null, quotaBytes: null, percent: null });
  });

  it('returns usage data from navigator.storage.estimate()', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn().mockResolvedValue({ usage: 1024 * 1024, quota: 10 * 1024 * 1024 }),
      },
    });
    const result = await getStorageUsage();
    expect(result.usedBytes).toBe(1024 * 1024);
    expect(result.quotaBytes).toBe(10 * 1024 * 1024);
    expect(result.percent).toBe(10);
  });

  it('returns null percent when quota is zero (division guard)', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 0 }) },
    });
    const result = await getStorageUsage();
    expect(result.percent).toBeNull();
  });

  it('returns null for usedBytes/quotaBytes when estimate returns non-numeric values (covers lines 50-51)', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn().mockResolvedValue({ usage: undefined, quota: 'unknown' }) },
    });
    const result = await getStorageUsage();
    expect(result.usedBytes).toBeNull(); // typeof undefined !== 'number' → null
    expect(result.quotaBytes).toBeNull(); // typeof 'unknown' !== 'number' → null
    expect(result.percent).toBeNull();
  });

  it('returns null fields when estimate() throws', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn().mockRejectedValue(new Error('permission denied')) },
    });
    const result = await getStorageUsage();
    expect(result).toEqual({ usedBytes: null, quotaBytes: null, percent: null });
  });
});

describe('autoCompactOnStartup', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('runs compactStorage and logs when keys are removed', async () => {
    const { autoCompactOnStartup } = await import('../../apps/web/src/lib/storage-maintenance.js');

    const storage = new InMemoryStorage();
    const old = isoDaysAgo(120);
    await storage.set(`kinetic:vitalite:done:${old}`, ['t1']);

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await autoCompactOnStartup(storage);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('auto-compact removed 1'));
    infoSpy.mockRestore();
  });

  it('runs silently when no keys are removed', async () => {
    const { autoCompactOnStartup } = await import('../../apps/web/src/lib/storage-maintenance.js');

    const storage = new InMemoryStorage();
    await storage.set('kinetic:xp', { xp: 100 }); // non-daily key, never removed

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await autoCompactOnStartup(storage);
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it('is idempotent — second call within same module instance is a no-op', async () => {
    const { autoCompactOnStartup } = await import('../../apps/web/src/lib/storage-maintenance.js');

    const storage = new InMemoryStorage();
    const old = isoDaysAgo(120);
    await storage.set(`kinetic:vitalite:done:${old}`, ['t']);

    await autoCompactOnStartup(storage); // first call — removes key
    await storage.set(`kinetic:vitalite:done:${old}`, ['t']); // restore
    await autoCompactOnStartup(storage); // second call — flag is set, does nothing

    // Key still present because second call was skipped
    expect(await storage.get(`kinetic:vitalite:done:${old}`)).not.toBeNull();
  });

  it('catches errors and logs a warning instead of throwing', async () => {
    const { autoCompactOnStartup } = await import('../../apps/web/src/lib/storage-maintenance.js');

    const badStorage = {
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn().mockRejectedValue(new Error('IDB error')),
      clear: vi.fn(),
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(autoCompactOnStartup(badStorage as any)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto-compact failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
