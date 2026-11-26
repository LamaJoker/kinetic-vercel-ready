/**
 * Photos de progrès : une base d'images PAR COMPTE (sync.md § 4.1), effacée avec les
 * données de l'appareil ou du compte (audit stockage local F7). idb-keyval est remplacé
 * par un moteur en mémoire où chaque base est identifiée par son NOM (comme IndexedDB :
 * deux createStore sur le même nom voient les mêmes données).
 */
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

const dbs = new Map<string, Map<string, unknown>>();
const db = (name: string): Map<string, unknown> => {
  let m = dbs.get(name);
  if (!m) dbs.set(name, (m = new Map()));
  return m;
};
vi.mock('idb-keyval', () => ({
  createStore: (name: string) => name,
  get: async (key: string, store: string) => db(store).get(key),
  set: async (key: string, value: unknown, store: string) => void db(store).set(key, value),
  del: async (key: string, store: string) => void db(store).delete(key),
  clear: async (store: string) => db(store).clear(),
}));

const photos = await import('../../apps/web/src/lib/photos.js');
const legacySet = (key: string, value: unknown) => db('kinetic-photos').set(key, value);

class AccountStorage extends InMemoryStorage {
  constructor(readonly owner: string) {
    super();
  }
}

const blob = (s: string) => s as unknown as Blob;
const meta = (id: string) => ({ id, takenAt: '2026-11-01T08:00:00.000Z' });
const dump = (name: string) => [...db(name).keys()].sort();

describe('photos : base d images par compte', () => {
  it('nom de base : compte, invité, repli (kinetic-u-…), sinon ancienne base commune', () => {
    expect(photos.photoDbName(new AccountStorage('u1'))).toBe('kinetic-photos-u-u1');
    expect(photos.photoDbName(new AccountStorage('guest'))).toBe('kinetic-photos-guest');
    const fallback = Object.assign(new InMemoryStorage(), { target: 'kinetic-u-u2' });
    expect(photos.photoDbName(fallback)).toBe('kinetic-photos-u-u2');
    expect(photos.photoDbName(new InMemoryStorage())).toBeNull();
  });

  it('A et B sur le même appareil : chacun ses images, effacer A ne touche pas B', async () => {
    const a = new AccountStorage('alice');
    const b = new AccountStorage('bob');
    await photos.addPhoto(a, blob('jpeg-a'), meta('pa'));
    await photos.addPhoto(b, blob('jpeg-b'), meta('pb'));
    expect(dump('kinetic-photos-u-alice')).toEqual(['pa']);
    expect(dump('kinetic-photos-u-bob')).toEqual(['pb']);
    // B ne voit jamais l'image de A, même en connaissant son identifiant.
    expect(await photos.getPhotoBlob(b, meta('pa'))).toBeNull();

    await photos.clearAllPhotoBlobs(a);
    expect(dump('kinetic-photos-u-alice')).toEqual([]);
    expect(dump('kinetic-photos-u-bob')).toEqual(['pb']);
  });

  it('ancienne base commune : image déplacée dans la base du compte à la lecture, effacée avec le compte', async () => {
    legacySet('legacy-1', 'jpeg-legacy');
    legacySet('legacy-other', 'jpeg-autre');
    const c = new AccountStorage('carol');
    await c.set(STORAGE_KEYS.PROGRESS_PHOTOS, [meta('legacy-1')]);

    expect(await photos.getPhotoBlob(c, meta('legacy-1'))).toBe('jpeg-legacy');
    expect(dump('kinetic-photos-u-carol')).toEqual(['legacy-1']);
    expect(dump('kinetic-photos')).toEqual(['legacy-other']);

    // Image restée dans l'ancienne base (pas encore lue) : effacée d'après les métadonnées.
    legacySet('legacy-2', 'jpeg-2');
    await c.set(STORAGE_KEYS.PROGRESS_PHOTOS, [meta('legacy-1'), meta('legacy-2')]);
    await photos.clearAllPhotoBlobs(c);
    expect(dump('kinetic-photos-u-carol')).toEqual([]);
    // Celle d'un autre compte (absente des métadonnées de Carol) reste.
    expect(dump('kinetic-photos')).toEqual(['legacy-other']);
  });

  it('suppression d une photo : image retirée de la base du compte et de l ancienne base', async () => {
    const d = new AccountStorage('dan');
    await photos.addPhoto(d, blob('x'), meta('pd'));
    legacySet('pd', 'copie');
    await photos.deletePhoto(d, 'pd');
    expect(dump('kinetic-photos-u-dan')).toEqual([]);
    expect(dump('kinetic-photos')).not.toContain('pd');
    expect(await photos.loadPhotos(d)).toEqual([]);
  });
});

describe('Profil : effacer l appareil et supprimer le compte effacent les photos', () => {
  it('doReset et confirmDeleteAccount appellent l effacement des photos AVANT les données', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../apps/web/src/pages/profile.page.ts'),
      'utf8',
    );
    const reset = src.slice(src.indexOf('async doReset()'));
    expect(reset.indexOf('wipeLocalPhotos(')).toBeGreaterThan(-1);
    expect(reset.indexOf('wipeLocalPhotos(')).toBeLessThan(reset.indexOf('storage.clear()'));
    const del = src.slice(src.indexOf('async confirmDeleteAccount()'));
    expect(del.indexOf('wipeLocalPhotos(')).toBeGreaterThan(-1);
    expect(del.indexOf('wipeLocalPhotos(')).toBeLessThan(del.indexOf('destroyLocalDatabase()'));
  });
});
