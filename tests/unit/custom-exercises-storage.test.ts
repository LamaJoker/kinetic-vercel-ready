import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  loadCustomExercises,
  loadExercises,
  saveCustomExercises,
  saveExercises,
} from '../../apps/web/src/lib/training/storage.js';
import { mergeIntoStorage } from '../../apps/web/src/lib/training/import.js';
import { isBackedUpKey } from '../../apps/web/src/lib/backup.js';

const custom = {
  id: 'custom-hip-thrust',
  name: 'Hip thrust machine',
  muscles: ['glutes'],
  equipment: 'machine' as const,
  incrementKg: 5,
  custom: true,
};

describe('exercices personnalisés (stockage)', () => {
  let storage: InMemoryStorage;
  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sont ajoutés au catalogue et survivent à son remplacement', async () => {
    await saveCustomExercises(storage, [custom]);
    expect((await loadExercises(storage)).some((e) => e.id === custom.id)).toBe(true);

    // Mise à jour du catalogue (liste complète réécrite) : l'exercice perso n'y est pas copié…
    await saveExercises(storage, await loadExercises(storage));
    const catalog = await storage.get<{ id: string }[]>('kinetic:training:exercises');
    expect(catalog?.some((e) => e.id === custom.id)).toBe(false);
    // …et reste disponible.
    await storage.set('kinetic:training:exercises', [
      { id: 'sq', name: 'Squat', muscles: ['quads'], equipment: 'barbell', incrementKg: 2.5 },
    ]);
    const ids = (await loadExercises(storage)).map((e) => e.id);
    expect(ids).toEqual(['sq', custom.id]);
  });

  it('sont marqués custom à la lecture', async () => {
    await storage.set('kinetic:training:custom-exercises', [{ ...custom, custom: undefined }]);
    expect((await loadCustomExercises(storage))[0]?.custom).toBe(true);
  });

  it('sont inclus dans la sauvegarde complète (et donc la synchro)', () => {
    expect(isBackedUpKey('kinetic:training:custom-exercises')).toBe(true);
    expect(isBackedUpKey('kinetic:training:templates')).toBe(true);
  });

  it('un import Kinetic range les exercices perso à part', async () => {
    await mergeIntoStorage(
      storage,
      { sessions: [], exercises: [custom], createdExercises: [] } as never,
      'kinetic-json',
    );
    expect((await loadCustomExercises(storage)).map((e) => e.id)).toEqual([custom.id]);
  });
});
