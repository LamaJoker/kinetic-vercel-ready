/**
 * Migration locale : ancienne base unique `keyval-store` / `keyval` (idb-keyval) →
 * base par compte `kinetic-u-<id>` / `kinetic-guest` (docs/architecture/sync.md § 4.1).
 * Aucune clé perdue, outbox convertie, réconciliation correcte, ré-exécution sans effet,
 * ancienne base conservée.
 */
import { describe, expect, it } from 'vitest';
import { createDevice, dump, FakeSyncServer, type Device } from '../support/sync-harness';

const U1 = 'user-a';
const U2 = 'user-b';
const S = (id: string) => `kinetic:training:session:${id}`;

async function seedLegacy(dev: Device, entries: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = dev.factory.open('keyval-store');
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['keyval'], 'readwrite');
    for (const [k, v] of Object.entries(entries)) tx.objectStore('keyval').put(v, k);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}

function legacyData(): Record<string, unknown> {
  return {
    [S('local-only')]: { name: 'Hors outbox (jamais synchronisée)' },
    [S('pending')]: { name: 'En attente dans l ancienne outbox' },
    [S('same')]: { name: 'Identique au cloud' },
    'kinetic:xp': 500,
    'kinetic:prefs:theme': 'dark',
    [S('deleted-remotely')]: { name: 'Supprimée sur un autre appareil' },
    'kinetic:training:active-session': { sets: 2 },
    'kinetic:schema-version': 3,
    'kinetic:sync:cursor': '2026-11-20T10:00:00.000Z',
    'kinetic:sync:last-at': '2026-11-20T10:00:00.000Z',
    '_kinetic:initial-sync-done': true,
    'kinetic:sync:outbox': [
      [S('pending'), { op: 'set', attempts: 4, nextTryAt: 9e15, rev: 0 }],
      [S('removed'), { op: 'remove', attempts: 1, nextTryAt: 0, rev: 0 }],
      ['kinetic:ghost', { op: 'set', attempts: 0, nextTryAt: 0, rev: 0 }],
    ],
  };
}

describe('migration de keyval-store vers la base du compte', () => {
  it('copie tout (sauf les clés de synchro), convertit l outbox, conserve l ancienne base', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    const s = await dev.open(U1);
    expect(s.migration).toEqual({ status: 'migrated', keys: 8, outbox: 2, kept: 0 });

    const kv = dump(dev, 'kinetic-u-user-a', 'kv');
    expect(Object.keys(kv).sort()).toEqual(
      [
        S('local-only'),
        S('pending'),
        S('same'),
        'kinetic:xp',
        'kinetic:prefs:theme',
        S('deleted-remotely'),
        'kinetic:training:active-session',
        'kinetic:schema-version',
      ].sort(),
    );
    const outbox = dump(dev, 'kinetic-u-user-a', 'outbox');
    expect(outbox[S('pending')]).toMatchObject({
      op: 'set',
      base: null,
      origin: 'legacy',
      nextTryAt: 0,
    });
    expect(outbox[S('removed')]).toMatchObject({ op: 'delete', base: null, origin: 'legacy' });
    expect(outbox['kinetic:ghost']).toBeUndefined(); // « set » sans valeur : rien à pousser
    const meta = dump(dev, 'kinetic-u-user-a', 'meta');
    expect(meta).toMatchObject({ owner: U1, migratedFrom: 'keyval-store', needsReconcile: true });

    // Ancienne base intacte + marqueur.
    const legacy = dump(dev, 'keyval-store', 'keyval');
    expect(legacy['kinetic:xp']).toBe(500);
    // L'ancienne outbox, reprise dans la base du compte, est retirée de l'ancienne base
    // (comportement modifié délibérément : un retour arrière vers l'ancienne version la
    // rejouait et écrasait dans le cloud les modifications faites depuis ; voir
    // sync-compat-migration.test.ts). Les DONNÉES de l'ancienne base restent intactes.
    expect(legacy['kinetic:sync:outbox']).toBeUndefined();
    expect(legacy[S('pending')]).toEqual({ name: 'En attente dans l ancienne outbox' });
    expect(legacy['kinetic:migrated-to']).toBe('kinetic-u-user-a');
  });

  it('réconciliation au premier pull complet : rien n est perdu, rien n est écrasé en silence', async () => {
    const server = new FakeSyncServer();
    server.seed(U1, S('same'), { name: 'Identique au cloud' });
    server.seed(U1, 'kinetic:xp', 650); // différent : fusion par domaine
    server.seed(U1, S('cloud-only'), { name: 'Venue d un autre appareil' });
    server.seed(U1, S('deleted-remotely'), { name: 'x' });
    server.seed(U1, S('removed'), { name: 'supprimée ici hors-ligne' });
    await server
      .client(U1)
      .from('user_storage')
      .delete()
      .eq('user_id', U1)
      .eq('key', S('deleted-remotely'));
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    const s = await dev.open(U1);
    await s.sync();

    // Clé du cloud absente localement : appliquée.
    expect(await s.get(S('cloud-only'))).toEqual({ name: 'Venue d un autre appareil' });
    // Données locales jamais synchronisées (hors outbox) : poussées.
    expect(server.live(U1)[S('local-only')]).toEqual({ name: 'Hors outbox (jamais synchronisée)' });
    expect(server.live(U1)['kinetic:prefs:theme']).toBe('dark');
    // Entrée en attente de l'ancienne outbox : poussée.
    expect(server.live(U1)[S('pending')]).toEqual({ name: 'En attente dans l ancienne outbox' });
    // Tombstone du cloud sur une clé locale : appliquée APRÈS copie dans recovery.
    expect(await s.get(S('deleted-remotely'))).toBeNull();
    const rec = await s.listRecovery();
    expect(rec.some((r) => r.key === S('deleted-remotely') && r.reason === 'reconcile')).toBe(true);
    // Valeur différente, modifiée sur le serveur APRÈS le dernier pull de l'ancien client
    // (curseur legacy du 20/11, version serveur du 25/11) : la copie locale est périmée,
    // le cloud gagne et la valeur locale est mise de côté (comportement modifié
    // délibérément : avant, la valeur périmée écrasait le cloud ; voir
    // sync-compat-migration.test.ts, où le cas « écrite hors outbox après le dernier pull »
    // reste fusionné et poussé).
    expect(await s.get<number>('kinetic:xp')).toBe(650);
    expect(server.live(U1)['kinetic:xp']).toBe(650);
    expect(rec.some((r) => r.key === 'kinetic:xp' && r.value === 500)).toBe(true);
    // Suppression en attente de l'ancienne outbox (base inconnue) : résolue par stratégie,
    // la valeur serveur est conservée en copie.
    expect(server.row(U1, S('removed'))!.deleted).toBe(true);
    expect(rec.some((r) => r.key === S('removed'))).toBe(true);
    // Clés locales : jamais poussées.
    expect(server.live(U1)['kinetic:training:active-session']).toBeUndefined();
    expect(server.live(U1)['kinetic:schema-version']).toBeUndefined();
    expect(await s.pendingCount()).toBe(0);
    expect(dump(dev, 'kinetic-u-user-a', 'meta')['needsReconcile']).toBeUndefined();
  });

  it('ré-exécution : sans effet', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    const s1 = await dev.open(U1);
    await s1.set('kinetic:xp', 501);
    s1.dispose();
    const s2 = await dev.open(U1);
    expect(s2.migration).toEqual({ status: 'already-done' });
    expect(await s2.get('kinetic:xp')).toBe(501);
  });

  it('règle propriétaire : un autre compte ne reprend jamais les données migrées', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    (await dev.open(U1)).dispose();
    const b = await dev.open(U2);
    expect(b.migration).toEqual({ status: 'claimed-by-other', target: 'kinetic-u-user-a' });
    expect(await b.keys()).toEqual([]);
  });

  it('sans session au premier lancement : migration vers kinetic-guest, sans outbox', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    const g = await dev.open('guest');
    expect(g.migration).toMatchObject({ status: 'migrated', outbox: 0 });
    expect(dump(dev, 'kinetic-guest', 'outbox')).toEqual({});
    expect(await g.get('kinetic:xp')).toBe(500);
  });

  it('échec de la copie : transaction annulée, réessai réussi au lancement suivant', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    await seedLegacy(dev, legacyData());
    dev.fake.failNext(
      (op) => op.db === 'kinetic-u-user-a' && op.store === 'kv' && op.kind === 'put',
      'QuotaExceededError',
    );
    await expect(dev.open(U1)).rejects.toThrow();
    expect(dump(dev, 'kinetic-u-user-a', 'kv')).toEqual({});
    expect(dump(dev, 'kinetic-u-user-a', 'meta')['migratedFrom']).toBeUndefined();
    const s = await dev.open(U1);
    expect(s.migration).toMatchObject({ status: 'migrated', keys: 8 });
  });

  it('aucune ancienne base : rien à faire, et elle n est pas créée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    expect(s.migration).toEqual({ status: 'no-legacy' });
    expect(dev.fake.hasDatabase('keyval-store')).toBe(false);
  });
});
