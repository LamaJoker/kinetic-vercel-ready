import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations.js';

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
});
