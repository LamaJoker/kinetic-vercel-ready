import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EXERCISE_CATALOG_VERSION } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';
import { loadExercises, saveCustomExercises } from '../../apps/web/src/lib/training/storage.js';

const KEY = 'kinetic:training:exercises';
const VERSION_KEY = 'kinetic:training:catalog-version';
const sq = {
  id: 'sq',
  name: 'Back Squat',
  muscles: ['quads'],
  equipment: 'barbell',
  incrementKg: 2.5,
};
const hipThrust = {
  id: 'hip-thrust',
  name: 'Hip Thrust',
  muscles: ['glutes'],
  equipment: 'barbell',
  incrementKg: 2.5,
};

function stubCatalog(list: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => list });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('mise à jour du catalogue d’exercices', () => {
  let storage: InMemoryStorage;
  beforeEach(() => {
    storage = new InMemoryStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ajoute les nouveautés du catalogue à une liste stockée ancienne (sans version)', async () => {
    await storage.set(KEY, [{ ...sq, name: 'Back Sqaut', hidden: true }]);
    stubCatalog([sq, hipThrust]);
    const ids = (await loadExercises(storage)).map((e) => e.id);
    expect(ids).toEqual(['sq', 'hip-thrust']);
    const stored = await storage.get<{ id: string; name: string; hidden?: boolean }[]>(KEY);
    expect(stored?.[0]).toMatchObject({ name: 'Back Squat', hidden: true });
    expect(await storage.get(VERSION_KEY)).toBe(EXERCISE_CATALOG_VERSION);
  });

  it('garde les exercices importés et perso', async () => {
    await storage.set(KEY, [sq, { ...sq, id: 'strong-row', name: 'Row' }]);
    await saveCustomExercises(storage, [{ ...sq, id: 'custom-a', name: 'Mon exo', custom: true }]);
    stubCatalog([sq, hipThrust]);
    const ids = (await loadExercises(storage)).map((e) => e.id);
    expect(ids).toEqual(['sq', 'hip-thrust', 'strong-row', 'custom-a']);
  });

  it('ne retélécharge pas un catalogue à jour', async () => {
    await storage.set(KEY, [sq]);
    await storage.set(VERSION_KEY, EXERCISE_CATALOG_VERSION);
    const fetchMock = stubCatalog([sq, hipThrust]);
    expect((await loadExercises(storage)).map((e) => e.id)).toEqual(['sq']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hors ligne : garde la liste stockée, réessaie à la session suivante seulement', async () => {
    await storage.set(KEY, [sq]);
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadExercises(storage)).map((e) => e.id)).toEqual(['sq']);
    await loadExercises(storage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await storage.get(VERSION_KEY)).toBeNull();
  });
});
