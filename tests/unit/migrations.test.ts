import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations.js';
import { STORAGE_KEYS } from '@kinetic/core';

const SCHEMA_VERSION_KEY = 'kinetic:schema-version';

describe('runMigrationsIfNeeded', () => {
  it('sets schema version to 1 on fresh install', async () => {
    const storage = new InMemoryStorage();
    await runMigrationsIfNeeded(storage);
    const version = await storage.get<number>(SCHEMA_VERSION_KEY);
    expect(version).toBe(1);
  });

  it('is idempotent — calling twice with version=1 does not re-run migration', async () => {
    const storage = new InMemoryStorage();
    await runMigrationsIfNeeded(storage);
    const setSpy = vi.spyOn(storage, 'set');
    await runMigrationsIfNeeded(storage);
    // Second call: already at version 1, no set should happen
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('skips when schema version already equals SCHEMA_VERSION', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 1);
    const setSpy = vi.spyOn(storage, 'set');
    await runMigrationsIfNeeded(storage);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('treats stored version 0 as needing migration', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 0);
    await runMigrationsIfNeeded(storage);
    expect(await storage.get<number>(SCHEMA_VERSION_KEY)).toBe(1);
  });

  it('preserves existing data through v1 migration (baseline — no transforms)', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:xp', { xp: 999 });
    await storage.set('kinetic:streak', { count: 42 });

    await runMigrationsIfNeeded(storage);

    expect(await storage.get('kinetic:xp')).toEqual({ xp: 999 });
    expect(await storage.get('kinetic:streak')).toEqual({ count: 42 });
  });

  it('re-runs migrations for versions below current', async () => {
    const storage = new InMemoryStorage();
    // Simulate a stored version lower than SCHEMA_VERSION (0 → treat as needing migration)
    await storage.set(SCHEMA_VERSION_KEY, null as any);
    await runMigrationsIfNeeded(storage);
    expect(await storage.get<number>(SCHEMA_VERSION_KEY)).toBe(1);
  });

  it('uses navigator.locks when available to prevent concurrent runs', async () => {
    const storage = new InMemoryStorage();
    const lockRequest = vi.fn((key: string, fn: () => Promise<void>) => fn());
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });

    await runMigrationsIfNeeded(storage);

    expect(lockRequest).toHaveBeenCalledWith(
      expect.stringContaining('migration'),
      expect.any(Function),
    );
    vi.unstubAllGlobals();
  });

  it('dispatches error notification when restoreSnapshot itself fails during rollback', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:xp', { xp: 100 });

    // ALL set operations fail → migration fails AND restore-snapshot also fails
    vi.spyOn(storage, 'set').mockRejectedValue(new Error('no space left'));

    const dispatchSpy = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: dispatchSpy });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('no space left');

    // The inner catch must have dispatched the corruption-warning notification
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: STORAGE_KEYS.EVENT_NOTIFY }),
    );
    vi.unstubAllGlobals();
  });

  it('restores data snapshot and re-throws when persisting schema version fails', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:xp', { xp: 500 });
    await storage.set('kinetic:streak', { count: 7 });

    // Make storage.set fail only when writing the schema-version key
    const original = storage.set.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === SCHEMA_VERSION_KEY) return Promise.reject(new Error('disk full'));
      return original(key, value);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('disk full');

    // Original data must still be intact after rollback
    expect(await storage.get('kinetic:xp')).toEqual({ xp: 500 });
    expect(await storage.get('kinetic:streak')).toEqual({ count: 7 });
  });

  it('removes null-valued keys during snapshot restore (null entry cleanup path)', async () => {
    const storage = new InMemoryStorage();
    // Store a key with null value — restoreSnapshot should remove it, not re-set it
    await storage.set('kinetic:xp', null as unknown as object);

    const originalSet = storage.set.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === SCHEMA_VERSION_KEY) return Promise.reject(new Error('disk full'));
      return originalSet(key, value);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('disk full');

    // After restore, the null-valued key must have been removed (not re-written as null)
    const keys = await storage.keys();
    expect(keys).not.toContain('kinetic:xp');
  });

  it('removes keys added during migration that were not in the original snapshot', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:xp', { xp: 100 });

    // Simulate a key appearing in storage between snapshot and restore (e.g. added by migration)
    let keysCallCount = 0;
    const origKeys = storage.keys.bind(storage);
    vi.spyOn(storage, 'keys').mockImplementation(async () => {
      keysCallCount++;
      const keys = await origKeys();
      // 2nd call is inside restoreSnapshot — inject an extra key
      if (keysCallCount >= 2) {
        return [...keys, 'kinetic:temp-migration-key'] as readonly string[];
      }
      return keys;
    });

    const removeSpy = vi.spyOn(storage, 'remove');

    const originalSet = storage.set.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === SCHEMA_VERSION_KEY) return Promise.reject(new Error('disk full'));
      return originalSet(key, value);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('disk full');

    // The extra key that appeared after the snapshot must have been removed
    expect(removeSpy).toHaveBeenCalledWith('kinetic:temp-migration-key');
  });
});
