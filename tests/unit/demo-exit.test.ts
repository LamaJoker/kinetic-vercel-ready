/**
 * Quitter la démo : les images des photos de démo (store IndexedDB
 * `kinetic-photos`) et les alertes de plateau masquées partent aussi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

const blobs = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  createStore: () => blobs,
  get: vi.fn(async (key: string) => blobs.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    blobs.set(key, value);
  }),
  del: vi.fn(async (key: string) => {
    blobs.delete(key);
  }),
}));

const { loadDemoData, clearDemoData, isDemoPhotoId } =
  await import('../../apps/web/src/lib/demo.js');

const NOW = new Date(2026, 8, 27, 12, 0);

beforeEach(() => blobs.clear());

describe('quitter la démo', () => {
  it('efface les images des photos de démo, pas celles de l’utilisateur', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    // Photos de démo migrées vers le store d'images à la première lecture.
    blobs.set('demo-photo-0', 'svg');
    blobs.set('demo-photo-3', 'svg');
    blobs.set('vraie-photo', 'jpeg');
    await clearDemoData(storage);
    expect([...blobs.keys()]).toEqual(['vraie-photo']);
    expect(await storage.get(STORAGE_KEYS.PROGRESS_PHOTOS)).toBeNull();
  });

  it('efface les alertes de plateau masquées pendant la démo', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    await storage.set(STORAGE_KEYS.PLATEAU_DISMISSED, { ohp: '2026-10-15T00:00:00.000Z' });
    await clearDemoData(storage);
    expect(await storage.get(STORAGE_KEYS.PLATEAU_DISMISSED)).toBeNull();
  });

  it('garde les masquages que l’utilisateur avait avant la démo', async () => {
    const storage = new InMemoryStorage();
    const mine = { squat: '2026-10-15T00:00:00.000Z' };
    await storage.set(STORAGE_KEYS.PLATEAU_DISMISSED, mine);
    await storage.set(STORAGE_KEYS.TRAINING_SESSION('vraie'), {
      id: 'vraie',
      startedAt: '2026-09-01T10:00:00Z',
      entries: [],
    });
    await loadDemoData(storage, NOW);
    await clearDemoData(storage);
    expect(await storage.get(STORAGE_KEYS.PLATEAU_DISMISSED)).toEqual(mine);
  });

  it('démo d’une version antérieure (manifeste sans la clé) : retirée s’il ne reste aucune séance', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    const manifest = (await storage.get<string[]>(STORAGE_KEYS.DEMO_MANIFEST))!;
    await storage.set(
      STORAGE_KEYS.DEMO_MANIFEST,
      manifest.filter((k) => k !== STORAGE_KEYS.PLATEAU_DISMISSED),
    );
    await storage.set(STORAGE_KEYS.PLATEAU_DISMISSED, { ohp: '2026-10-15T00:00:00.000Z' });
    await clearDemoData(storage);
    expect(await storage.get(STORAGE_KEYS.PLATEAU_DISMISSED)).toBeNull();
  });

  it('identifiants des photos de démo', () => {
    expect(isDemoPhotoId('demo-photo-2')).toBe(true);
    expect(isDemoPhotoId('photo-123')).toBe(false);
    expect(isDemoPhotoId(undefined)).toBe(false);
  });
});
