import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations.js';
import { STORAGE_KEYS } from '@kinetic/core';

const SCHEMA_VERSION_KEY = 'kinetic:schema-version';

describe('runMigrationsIfNeeded', () => {
  it('sets schema version to the latest (2) on fresh install', async () => {
    const storage = new InMemoryStorage();
    await runMigrationsIfNeeded(storage);
    const version = await storage.get<number>(SCHEMA_VERSION_KEY);
    expect(version).toBe(2);
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
    await storage.set(SCHEMA_VERSION_KEY, 2);
    const setSpy = vi.spyOn(storage, 'set');
    await runMigrationsIfNeeded(storage);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('treats stored version 0 as needing migration', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 0);
    await runMigrationsIfNeeded(storage);
    expect(await storage.get<number>(SCHEMA_VERSION_KEY)).toBe(2);
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
    expect(await storage.get<number>(SCHEMA_VERSION_KEY)).toBe(2);
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
    // Une migration qui écrit (pliage v2) : le retour arrière a quelque chose à défaire.
    await storage.set(SCHEMA_VERSION_KEY, 1);
    await storage.set('kinetic:training:sessions', [
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
    ]);

    // ALL writes fail → migration fails AND the rollback also fails
    vi.spyOn(storage, 'set').mockRejectedValue(new Error('no space left'));
    vi.spyOn(storage, 'remove').mockRejectedValue(new Error('no space left'));

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

  it('rollback ne touche pas une clé que la migration n a pas écrite (valeur null comprise)', async () => {
    const storage = new InMemoryStorage();
    // Clé présente avec une valeur null : la migration ne l'a pas écrite, le retour
    // arrière la laisse telle quelle (avant : restoreSnapshot la supprimait).
    await storage.set('kinetic:xp', null as unknown as object);

    const originalSet = storage.set.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === SCHEMA_VERSION_KEY) return Promise.reject(new Error('disk full'));
      return originalSet(key, value);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('disk full');

    expect(storage.has('kinetic:xp')).toBe(true);
    expect(await storage.get(SCHEMA_VERSION_KEY)).toBeNull();
  });

  it('logs a warning for unknown migration versions (covers default case at line 106)', async () => {
    const storage = new InMemoryStorage();
    // Pre-seed schema version to -1 so the loop starts at v=0, which hits default:
    // for (v = 0; v <= 1; v++): v=0 → runMigration(0) → default → console.warn
    await storage.set(SCHEMA_VERSION_KEY, -1 as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runMigrationsIfNeeded(storage);
    const warnArgs = warnSpy.mock.calls.flat().join(' ');
    expect(warnArgs).toContain('[migrations]');
    expect(warnArgs).toContain('unknown version');
    warnSpy.mockRestore();

    // Schema version should be set to SCHEMA_VERSION (1) after all migrations
    const version = await storage.get<number>(SCHEMA_VERSION_KEY);
    expect(version).toBe(2);
  });

  it('F2 : une clé écrite par l app PENDANT la migration n est pas supprimée au retour arrière', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 1);
    await storage.set('kinetic:training:sessions', [
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
    ]);
    const originalSet = storage.set.bind(storage);
    vi.spyOn(storage, 'set').mockImplementation(async (key: string, value: unknown) => {
      if (key === 'kinetic:training:session:a') {
        // Pendant le pliage v2, l'utilisateur termine une séance (écriture directe de la page).
        await originalSet('kinetic:training:session:today', { id: 'today', name: 'Jambes' });
      }
      if (key === SCHEMA_VERSION_KEY) throw new DOMException('quota', 'QuotaExceededError');
      return originalSet(key, value);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('quota');

    // La séance du jour est intacte ; ce que la migration avait écrit est annulé ; l'ancien
    // tableau est revenu (rien n'est perdu, la migration sera rejouée au lancement suivant).
    expect(await storage.get('kinetic:training:session:today')).toEqual({
      id: 'today',
      name: 'Jambes',
    });
    expect(storage.has('kinetic:training:session:a')).toBe(false);
    expect(await storage.get('kinetic:training:sessions')).toEqual([
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
    ]);
    expect(await storage.get(SCHEMA_VERSION_KEY)).toBe(1);
  });

  it('F2 : le retour arrière ne réécrit pas les clés que la migration n a pas touchées', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 1);
    await storage.set('kinetic:xp', { xp: 100 });
    await storage.set('kinetic:training:sessions', [
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
    ]);
    const originalSet = storage.set.bind(storage);
    const written: string[] = [];
    const removed: string[] = [];
    vi.spyOn(storage, 'set').mockImplementation(async (key: string, value: unknown) => {
      if (key === SCHEMA_VERSION_KEY) throw new Error('disk full');
      written.push(key);
      return originalSet(key, value);
    });
    const originalRemove = storage.remove.bind(storage);
    vi.spyOn(storage, 'remove').mockImplementation(async (key: string) => {
      removed.push(key);
      return originalRemove(key);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('disk full');

    // Seules les clés du pliage sont rejouées (pas de réécriture massive vers le cloud).
    expect(new Set(written)).toEqual(
      new Set(['kinetic:training:session:a', 'kinetic:training:sessions']),
    );
    expect(new Set(removed)).toEqual(
      new Set(['kinetic:training:sessions', 'kinetic:training:session:a']),
    );
    expect(await storage.get('kinetic:xp')).toEqual({ xp: 100 });
  });

  it('F2 : une lecture en échec pendant la migration n efface rien (pas de cliché « null »)', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 1);
    await storage.set('kinetic:training:sessions', [
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
    ]);
    await storage.set('kinetic:training:session:old', { id: 'old', name: 'Ancienne' });
    const originalGet = storage.get.bind(storage);
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === 'kinetic:training:session:a') throw new Error('Connection lost');
      return originalGet(key);
    });

    await expect(runMigrationsIfNeeded(storage)).rejects.toThrow('Connection lost');

    expect(await originalGet('kinetic:training:session:old')).toEqual({
      id: 'old',
      name: 'Ancienne',
    });
    expect(await originalGet('kinetic:training:sessions')).toHaveLength(1);
  });

  it('v2 : replie le tableau legacy des séances en une clé par séance', async () => {
    const storage = new InMemoryStorage();
    await storage.set(SCHEMA_VERSION_KEY, 1);
    await storage.set('kinetic:training:sessions', [
      { id: 'a', name: 'Push', startedAt: '2026-01-01T10:00:00Z', entries: [] },
      { id: 'b', name: 'Pull', startedAt: '2026-01-03T10:00:00Z', entries: [] },
      { broken: true },
    ]);
    // Une version plus récente au nouveau format ne doit pas être écrasée
    await storage.set('kinetic:training:session:b', {
      id: 'b',
      name: 'Pull (édité)',
      startedAt: '2026-01-03T10:00:00Z',
      entries: [],
    });

    await runMigrationsIfNeeded(storage);

    expect(await storage.get(SCHEMA_VERSION_KEY)).toBe(2);
    expect(await storage.get('kinetic:training:sessions')).toBeNull();
    expect(await storage.get('kinetic:training:session:a')).toMatchObject({ name: 'Push' });
    expect(await storage.get('kinetic:training:session:b')).toMatchObject({ name: 'Pull (édité)' });
  });
});
