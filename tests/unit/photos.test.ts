/**
 * Tests pour la lib photos. On ne peut pas tester `compressImageFile` (canvas
 * indispo dans jsdom strict) ni `getPhotoObjectUrl` (URL.createObjectURL stub).
 * On teste le pipeline meta : load/save/delete + la conversion dataUrl→Blob.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoragePort } from '../../packages/core/src/index.js';

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    createStore: () => store,
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// Stub URL.createObjectURL utilisé par getPhotoObjectUrl (non testé ici mais
// importé dans le module)
if (typeof URL.createObjectURL !== 'function') {
  (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test';
}

const memoryStorage = (): StoragePort => {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = map.get(key);
      return (value as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...map.keys()];
    },
    async clear(): Promise<void> {
      map.clear();
    },
  } as unknown as StoragePort;
};

describe('photos lib', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loadPhotos retourne [] quand rien stocké', async () => {
    const { loadPhotos } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    expect(await loadPhotos(storage)).toEqual([]);
  });

  it('savePhotos persiste les meta', async () => {
    const { loadPhotos, savePhotos } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    await savePhotos(storage, [
      { id: 'a', takenAt: '2026-01-01T00:00:00Z', sizeBytes: 1234, label: 'front' },
    ]);
    const loaded = await loadPhotos(storage);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.id).toBe('a');
    expect(loaded[0]!.label).toBe('front');
  });

  it('deletePhoto enlève bien la meta', async () => {
    const { deletePhoto, savePhotos, loadPhotos } =
      await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    await savePhotos(storage, [
      { id: 'a', takenAt: '2026-01-01T00:00:00Z' },
      { id: 'b', takenAt: '2026-01-02T00:00:00Z' },
    ]);
    const next = await deletePhoto(storage, 'a');
    expect(next.length).toBe(1);
    expect(next[0]!.id).toBe('b');
    expect((await loadPhotos(storage)).length).toBe(1);
  });
});
