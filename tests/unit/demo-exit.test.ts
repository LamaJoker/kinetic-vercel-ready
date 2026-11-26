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

  it('F10 : les saisies réelles faites pendant la démo sont gardées (pesée, repas, mensuration, photo)', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    const today = '2026-09-27';
    const withReal = async <T>(key: string, add: T) => {
      const cur = (await storage.get<T[]>(key)) ?? [];
      await storage.set(key, [...cur.filter((e) => (e as { date?: string }).date !== today), add]);
    };
    // Pesée réelle du jour (remplace celle de la démo pour la même date) et autres saisies.
    await withReal(STORAGE_KEYS.BODYWEIGHT_ENTRIES, {
      date: today,
      weight: 82.4,
      bodyFatPct: null,
      note: null,
    });
    await withReal(STORAGE_KEYS.MEASUREMENTS_ENTRIES, { id: 'm-vraie', date: today, waist: 84 });
    await withReal(STORAGE_KEYS.NUTRITION_LOG(today), {
      id: 'meal-vrai',
      mealName: 'Dîner',
      loggedAt: '2026-09-27T19:00:00.000Z',
      items: [],
    });
    await withReal(STORAGE_KEYS.PROGRESS_PHOTOS, { id: 'vraie-photo', takenAt: today });
    blobs.set('vraie-photo', 'jpeg');

    await clearDemoData(storage);

    expect(await storage.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toEqual([
      { date: today, weight: 82.4, bodyFatPct: null, note: null },
    ]);
    expect(await storage.get(STORAGE_KEYS.MEASUREMENTS_ENTRIES)).toEqual([
      { id: 'm-vraie', date: today, waist: 84 },
    ]);
    expect(
      (await storage.get<Array<{ id: string }>>(STORAGE_KEYS.NUTRITION_LOG(today)))?.map(
        (m) => m.id,
      ),
    ).toEqual(['meal-vrai']);
    expect(await storage.get(STORAGE_KEYS.PROGRESS_PHOTOS)).toEqual([
      { id: 'vraie-photo', takenAt: today },
    ]);
    expect(blobs.has('vraie-photo')).toBe(true);
    // Ce qui ne vient que de la démo part toujours.
    expect(await storage.get(STORAGE_KEYS.DEMO_MANIFEST)).toBeNull();
    expect(await storage.get(STORAGE_KEYS.USER_PROFILE)).toBeNull();
    expect((await storage.keys()).filter((k) => k.startsWith('kinetic:training:session:'))).toEqual(
      [],
    );
  });

  it('F10 : sans saisie réelle, toutes les clés de la démo sont retirées', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    await clearDemoData(storage);
    expect(storage.size).toBe(0);
  });

  it('F10 : démo d une version antérieure (pesées non marquées) : pesées retirées comme avant', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    const bw = (await storage.get<Array<Record<string, unknown>>>(
      STORAGE_KEYS.BODYWEIGHT_ENTRIES,
    ))!;
    await storage.set(
      STORAGE_KEYS.BODYWEIGHT_ENTRIES,
      bw.map(({ demo: _d, ...rest }) => rest),
    );
    await clearDemoData(storage);
    expect(await storage.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toBeNull();
  });
});
