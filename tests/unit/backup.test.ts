import { describe, it, expect } from 'vitest';
import { isBackedUpKey, restoreStorage, snapshotStorage } from '../../apps/web/src/lib/backup.js';
import { buildJsonExport } from '../../apps/web/src/lib/training/export.js';
import { parseKineticJson } from '../../apps/web/src/lib/training/import.js';
import { InMemoryStorage } from '../helpers/stubs.js';

describe('isBackedUpKey', () => {
  it("garde les données de l'application", () => {
    expect(isBackedUpKey('kinetic:bodyweight:entries')).toBe(true);
    expect(isBackedUpKey('kinetic:xp')).toBe(true);
  });

  it('écarte séances, exercices et clés propres à cet appareil', () => {
    expect(isBackedUpKey('kinetic:training:session:abc')).toBe(false);
    expect(isBackedUpKey('kinetic:training:sessions')).toBe(false);
    expect(isBackedUpKey('kinetic:training:exercises')).toBe(false);
    expect(isBackedUpKey('kinetic:sync:outbox')).toBe(false);
    expect(isBackedUpKey('kinetic:deviceId')).toBe(false);
    expect(isBackedUpKey('_kinetic:initial-sync-done')).toBe(false);
    expect(isBackedUpKey('autre-app:clé')).toBe(false);
  });
});

describe('sauvegarde complète', () => {
  it('copie puis restaure les données sur un autre appareil', async () => {
    const source = new InMemoryStorage();
    await source.set('kinetic:bodyweight:entries', [{ date: '2026-05-01', weight: 80 }]);
    await source.set('kinetic:xp', { xp: 1200 });
    await source.set('kinetic:sync:outbox', ['ne pas copier']);

    const data = await snapshotStorage(source);
    expect(Object.keys(data)).toEqual(['kinetic:bodyweight:entries', 'kinetic:xp']);

    const bundle = parseKineticJson(buildJsonExport([], [], data));
    expect(bundle.data).toEqual(data);

    const target = new InMemoryStorage();
    await target.set('kinetic:xp', { xp: 0 });
    expect(await restoreStorage(target, { ...bundle.data!, 'kinetic:deviceId': 'x' })).toBe(2);
    expect(await target.get('kinetic:xp')).toEqual({ xp: 1200 });
    expect(await target.get('kinetic:deviceId')).toBeNull();
  });

  it("un ancien export (version 1) n'a pas de données complémentaires", () => {
    const json = buildJsonExport([], []);
    expect(JSON.parse(json).version).toBe(1);
    expect(parseKineticJson(json).data).toBeUndefined();
    expect(JSON.parse(buildJsonExport([], [], {})).version).toBe(2);
  });
});
