/**
 * tests/unit/storage-maintenance.test.ts
 * Couvre la purge des clés journalières > 90 jours.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { StoragePort } from '@kinetic/core';
import { compactStorage, formatBytes } from '../../apps/web/src/lib/storage-maintenance';

class InMemoryStorage implements StoragePort {
  private store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async remove(key: string): Promise<void> { this.store.delete(key); }
  async keys(): Promise<readonly string[]> { return [...this.store.keys()]; }
  async clear(): Promise<void> { this.store.clear(); }
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

  it("ne supprime pas une clé avec date invalide (par sécurité)", async () => {
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
