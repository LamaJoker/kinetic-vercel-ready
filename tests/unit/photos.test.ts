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

  it('addPhoto stocke le Blob + crée la meta correspondante', async () => {
    const { addPhoto, loadPhotos } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    const next = await addPhoto(storage, blob, {
      id: 'p1',
      takenAt: '2026-05-27T10:00:00Z',
      bodyweightKg: 78.5,
      label: 'front',
    });
    expect(next.length).toBe(1);
    expect(next[0]!.id).toBe('p1');
    expect(next[0]!.bodyweightKg).toBe(78.5);
    expect(next[0]!.label).toBe('front');
    expect(next[0]!.sizeBytes).toBe(blob.size);
    expect((await loadPhotos(storage)).length).toBe(1);
  });

  it('getPhotoBlob migre une photo legacy dataUrl vers le store Blob', async () => {
    const { getPhotoBlob, loadPhotos, savePhotos } =
      await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    // dataURL minimal JPEG (header + 0 byte body)
    const dataUrl =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAEAAQMBIgACEQEDEQH/xAAUAAEAAAAAAAAAAAAAAAAAAAAJ/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AHwAf/9k=';
    await savePhotos(storage, [{ id: 'p1', takenAt: '2026-05-27T10:00:00Z', dataUrl }]);
    const blob = await getPhotoBlob(storage, {
      id: 'p1',
      takenAt: '2026-05-27T10:00:00Z',
      dataUrl,
    });
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/jpeg');
    // Meta doit avoir été nettoyé du dataUrl après migration
    const cleaned = await loadPhotos(storage);
    expect(cleaned[0]!.dataUrl).toBeUndefined();
    expect(cleaned[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it('getPhotoBlob retourne null si aucune donnée disponible', async () => {
    const { getPhotoBlob } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const blob = await getPhotoBlob(storage, { id: 'ghost', takenAt: '2026-01-01T00:00:00Z' });
    expect(blob).toBeNull();
  });

  it('deletePhoto enlève aussi le Blob du store IDB dédié', async () => {
    const { addPhoto, deletePhoto, getPhotoBlob } =
      await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const blob = new Blob([new Uint8Array([0xff])], { type: 'image/jpeg' });
    await addPhoto(storage, blob, { id: 'x', takenAt: '2026-05-27T10:00:00Z' });
    await deletePhoto(storage, 'x');
    expect(await getPhotoBlob(storage, { id: 'x', takenAt: '2026-05-27T10:00:00Z' })).toBeNull();
  });

  it('getPhotoObjectUrl crée un object URL pour le Blob', async () => {
    let urlCalled = '';
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      urlCalled = `blob:fake-${b.size}`;
      return urlCalled;
    };
    const { addPhoto, getPhotoObjectUrl } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    await addPhoto(storage, blob, { id: 'p1', takenAt: '2026-05-27T10:00:00Z' });
    const url = await getPhotoObjectUrl(storage, { id: 'p1', takenAt: '2026-05-27T10:00:00Z' });
    expect(url).toBe(urlCalled);
    expect(url).toContain('blob:fake-');
  });

  it('getPhotoObjectUrl retourne null si aucun blob trouvé', async () => {
    const { getPhotoObjectUrl } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const url = await getPhotoObjectUrl(storage, { id: 'ghost', takenAt: '2026-01-01T00:00:00Z' });
    expect(url).toBeNull();
  });

  it('downloadPhoto crée un <a> et le clique', async () => {
    let downloadName = '';
    let clicked = false;
    // Stub URL.createObjectURL + revokeObjectURL
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:fake';
    (URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL = () => undefined;
    // Stub document.createElement + appendChild + removeChild
    const fakeAnchor = {
      href: '',
      download: '',
      click() {
        clicked = true;
        downloadName = this.download;
      },
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => (tag === 'a' ? fakeAnchor : ({} as HTMLElement)),
      body: {
        appendChild: () => undefined,
        removeChild: () => undefined,
      },
    };

    const { addPhoto, downloadPhoto } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    const blob = new Blob([new Uint8Array([0xff])], { type: 'image/jpeg' });
    await addPhoto(storage, blob, {
      id: 'p2',
      takenAt: '2026-05-27T10:00:00Z',
      label: 'side',
    });
    await downloadPhoto(storage, { id: 'p2', takenAt: '2026-05-27T10:00:00Z', label: 'side' });
    expect(clicked).toBe(true);
    expect(downloadName).toContain('kinetic-side-2026-05-27');
    expect(downloadName.endsWith('.jpg')).toBe(true);

    // Cleanup global stub
    delete (globalThis as Record<string, unknown>).document;
  });

  it('downloadPhoto no-op si aucun blob disponible', async () => {
    const { downloadPhoto } = await import('../../apps/web/src/lib/photos.js');
    const storage = memoryStorage();
    // Aucun document stub installé → ne doit pas throw même si l'API DOM manque
    // car la fonction sort tôt sur blob null.
    await expect(
      downloadPhoto(storage, { id: 'ghost', takenAt: '2026-01-01T00:00:00Z' }),
    ).resolves.toBeUndefined();
  });

  it('compressImageFile : pipeline avec stubs Image + canvas', async () => {
    // Stub FileReader, Image, canvas pour exercer toute la pipeline pure
    // (fitToMax, ratio, JPEG export).
    (globalThis as Record<string, unknown>).FileReader = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: string = '';
      readAsDataURL(_blob: Blob) {
        this.result = 'data:image/jpeg;base64,xxx';
        queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as Record<string, unknown>).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 2048;
      naturalHeight = 1536;
      _src = '';
      set src(v: string) {
        this._src = v;
        queueMicrotask(() => this.onload?.());
      }
      get src() {
        return this._src;
      }
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => undefined }),
            toBlob: (cb: (b: Blob) => void, _type?: string, _quality?: number) => {
              cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }));
            },
          };
        }
        return { href: '', download: '', click: () => undefined };
      },
      body: { appendChild: () => undefined, removeChild: () => undefined },
    };
    const { compressImageFile } = await import('../../apps/web/src/lib/photos.js');
    const fakeFile = new Blob([new Uint8Array([0])], { type: 'image/png' }) as Blob & File;
    const result = await compressImageFile(fakeFile);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/jpeg');
    delete (globalThis as Record<string, unknown>).FileReader;
    delete (globalThis as Record<string, unknown>).Image;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('compressImageFile préserve une image qui tient déjà dans MAX_DIM', async () => {
    (globalThis as Record<string, unknown>).FileReader = class {
      onload: (() => void) | null = null;
      result = 'data:image/jpeg;base64,xxx';
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as Record<string, unknown>).Image = class {
      onload: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: (cb: (b: Blob) => void) => cb(new Blob(['xx'], { type: 'image/jpeg' })),
      }),
    };
    const { compressImageFile } = await import('../../apps/web/src/lib/photos.js');
    const out = await compressImageFile(new Blob() as File);
    expect(out).toBeInstanceOf(Blob);
    delete (globalThis as Record<string, unknown>).FileReader;
    delete (globalThis as Record<string, unknown>).Image;
    delete (globalThis as Record<string, unknown>).document;
  });

  it('compressImageFile : branche portrait (hauteur > largeur)', async () => {
    (globalThis as Record<string, unknown>).FileReader = class {
      onload: (() => void) | null = null;
      result = 'data:image/jpeg;base64,xxx';
      readAsDataURL() {
        queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as Record<string, unknown>).Image = class {
      onload: (() => void) | null = null;
      naturalWidth = 600;
      naturalHeight = 2000; // portrait, plus haut que MAX_DIM
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    };
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: (cb: (b: Blob) => void) => cb(new Blob(['x'], { type: 'image/jpeg' })),
      }),
    };
    const { compressImageFile } = await import('../../apps/web/src/lib/photos.js');
    const out = await compressImageFile(new Blob() as File);
    expect(out).toBeInstanceOf(Blob);
    delete (globalThis as Record<string, unknown>).FileReader;
    delete (globalThis as Record<string, unknown>).Image;
    delete (globalThis as Record<string, unknown>).document;
  });
});
