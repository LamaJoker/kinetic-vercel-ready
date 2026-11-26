/**
 * Revue adversariale « concurrence et réseau » : repli sur l'ancienne base `keyval-store`
 * (base du compte impossible à ouvrir) quand PLUSIEURS comptes se succèdent sur l'appareil.
 *
 * L'ancienne base est unique pour tout l'appareil. Elle appartient à la base qui l'a
 * migrée (marqueur `kinetic:migrated-to`) ; les écritures faites en repli y sont
 * journalisées par base cible. Deux exigences :
 *  - un compte en repli ne voit jamais les données d'un autre compte (ni de l'invité) ;
 *  - « Effacer les données de cet appareil » pendant le repli d'un compte ne détruit pas
 *    les écritures de repli d'un AUTRE compte (sinon leur reprise les prend pour des
 *    suppressions : séance supprimée localement puis dans le cloud).
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  SupabaseSyncRemote,
  SyncedStorage,
  openLegacyFallbackStorage,
} from '@kinetic/adapters-web';
import { createFakeIndexedDB } from '../support/fake-indexeddb';
import { FakeSyncServer } from '../support/fake-sync-server';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const S = (id: string): string => `${STORAGE_KEYS.TRAINING_SESSION_PREFIX}${id}`;

async function writeLegacyDb(idb: IDBFactory, data: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open('keyval-store');
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['keyval'], 'readwrite');
    for (const [k, v] of Object.entries(data)) tx.objectStore('keyval').put(v, k);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

function open(
  server: FakeSyncServer,
  idb: IDBFactory,
  uid: string,
  recoverFallbackWrites = false,
): Promise<SyncedStorage> {
  return SyncedStorage.open({
    owner: uid,
    remote: new SupabaseSyncRemote(server.client(uid) as never, uid),
    factory: idb,
    autoSync: false,
    eventTarget: new EventTarget(),
    isOnline: () => true,
    recoverFallbackWrites,
  });
}

describe('repli sur l ancienne base partagée entre comptes', () => {
  it('un compte en repli ne voit pas les données de l ancienne base migrées vers une autre base', async () => {
    const { factory: idb } = createFakeIndexedDB();
    // Ancienne base de l'appareil, migrée vers la base invité (premier lancement en invité).
    await writeLegacyDb(idb, {
      [S('guest-1')]: { id: 'guest-1', note: 'séance invité' },
      'kinetic:settings': { unit: 'lb' },
      [STORAGE_KEYS.SYNC_MIGRATED_TO]: 'kinetic-guest',
    });

    // Alice se connecte ; sa base ne s'ouvre pas : repli.
    const fallback = await openLegacyFallbackStorage({ factory: idb, owner: ALICE });
    expect(await fallback.get(S('guest-1'))).toBeNull();
    expect(await fallback.get('kinetic:settings')).toBeNull();
    expect(await fallback.keys()).toEqual([]);

    // Ses propres écritures de repli restent visibles.
    await fallback.set(S('a-1'), { id: 'a-1' });
    expect(await fallback.get(S('a-1'))).toEqual({ id: 'a-1' });
    expect(await fallback.keys()).toEqual([S('a-1')]);
  });

  it('« Effacer les données de cet appareil » en repli d Alice ne supprime pas la séance de Bob', async () => {
    const server = new FakeSyncServer();
    const { factory: idb } = createFakeIndexedDB();

    // Bob : base du compte, une séance synchronisée.
    const bob = await open(server, idb, BOB);
    await bob.set(S('b-1'), { id: 'b-1', reps: 5 });
    await bob.sync({ ignoreBackoff: true });
    bob.dispose();

    // Bob en repli : il corrige sa séance (journalisée pour sa base).
    const bobFallback = await openLegacyFallbackStorage({ factory: idb, owner: BOB });
    await bobFallback.set(S('b-1'), { id: 'b-1', reps: 8 });

    // Puis Alice, aussi en repli, efface « les données de cet appareil ».
    const aliceFallback = await openLegacyFallbackStorage({ factory: idb, owner: ALICE });
    await aliceFallback.clear();

    // Bob revient, sa base s'ouvre : reprise du repli puis synchro.
    const bobAgain = await open(server, idb, BOB, true);
    await bobAgain.sync({ ignoreBackoff: true });
    expect(await bobAgain.get(S('b-1'))).toEqual({ id: 'b-1', reps: 8 });
    expect(server.live(BOB)[S('b-1')]).toEqual({ id: 'b-1', reps: 8 });
    bobAgain.dispose();
  });

  it('ancienne base pas encore migrée : les écritures de repli d Alice ne partent pas chez Bob', async () => {
    const server = new FakeSyncServer();
    const { factory: idb } = createFakeIndexedDB();
    // Ancienne version de l'app utilisée par Alice ; pas encore de base par compte.
    await writeLegacyDb(idb, { [S('a-1')]: { id: 'a-1' } });

    // Nouvelle version : la base d'Alice ne s'ouvre pas, repli ; elle enregistre une séance.
    const aliceFallback = await openLegacyFallbackStorage({ factory: idb, owner: ALICE });
    await aliceFallback.set(S('a-2'), { id: 'a-2' });

    // Bob se connecte ensuite sur l'appareil ; sa base s'ouvre (première migration).
    const bob = await open(server, idb, BOB);
    await bob.sync({ ignoreBackoff: true });
    expect(await bob.keys()).toEqual([]);
    expect(server.live(BOB)).toEqual({});
    bob.dispose();

    // Alice revient : tout est chez elle.
    const alice = await open(server, idb, ALICE, true);
    await alice.sync({ ignoreBackoff: true });
    expect([...(await alice.keys())].sort()).toEqual([S('a-1'), S('a-2')]);
    expect(Object.keys(server.live(ALICE)).sort()).toEqual([S('a-1'), S('a-2')]);
    alice.dispose();
  });
});
