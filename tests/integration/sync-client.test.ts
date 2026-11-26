/**
 * Client de synchro (SyncedStorage) contre un faux serveur 010 fidèle et un IndexedDB
 * en mémoire (tests/support). Aucun comportement testé n'est mocké : les écritures
 * passent par de vraies transactions, les RPC par la sémantique SQL de 010.
 */
import { describe, expect, it } from 'vitest';
import { createMergeRegistry, lwwStrategy, type MergeStrategy } from '@kinetic/core';
import { SyncedStorage, OwnerMismatchError } from '@kinetic/adapters-web';
import { createDevice, dump, FakeSyncServer } from '../support/sync-harness';

const U1 = 'user-a';
const U2 = 'user-b';
const SESSION = (id: string) => `kinetic:training:session:${id}`;

describe('SyncedStorage — écriture locale et outbox atomiques', () => {
  it('une écriture crée valeur + entrée d outbox dans la même base, base = null', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'Push' });
    expect(dump(dev, 'kinetic-u-user-a', 'kv')).toEqual({ [SESSION('s1')]: { name: 'Push' } });
    const outbox = dump(dev, 'kinetic-u-user-a', 'outbox');
    expect(outbox[SESSION('s1')]).toMatchObject({
      op: 'set',
      base: null,
      state: 'pending',
      rev: 1,
    });
    expect(await s.pendingCount()).toBe(1);
  });

  it('écriture refusée par IndexedDB : erreur levée, ni valeur ni outbox (rollback)', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    dev.fake.failNext((op) => op.store === 'outbox' && op.kind === 'put', 'QuotaExceededError');
    await expect(s.set(SESSION('s1'), { name: 'Push' })).rejects.toThrow();
    expect(await s.get(SESSION('s1'))).toBeNull();
    expect(await s.pendingCount()).toBe(0);
  });

  it('setMany écrit tout ou rien', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:goals:list', [{ id: 'a' }]);
    dev.fake.failNext(
      (op) => op.kind === 'put' && op.key === 'kinetic:deleted:kinetic:goals:list',
      'QuotaExceededError',
    );
    await expect(
      s.setMany([
        { key: 'kinetic:goals:list', value: [] },
        { key: 'kinetic:deleted:kinetic:goals:list', value: { a: '2026-11-25T10:00:00.000Z' } },
      ]),
    ).rejects.toThrow();
    expect(await s.get('kinetic:goals:list')).toEqual([{ id: 'a' }]);
    expect(await s.get('kinetic:deleted:kinetic:goals:list')).toBeNull();
  });

  it('lecture en échec : erreur levée, jamais null (F3 qualité)', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:training:templates', [{ id: 'mine' }]);
    dev.fake.failNext((op) => op.kind === 'get' && op.store === 'kv', 'UnknownError', 2);
    await expect(s.get('kinetic:training:templates')).rejects.toThrow();
    expect(await s.get('kinetic:training:templates')).toEqual([{ id: 'mine' }]);
  });

  it('connexion IndexedDB perdue (WebKit) : la base est rouverte et la lecture réussit', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:xp', 120);
    dev.fake.breakConnections();
    expect(await s.get('kinetic:xp')).toBe(120);
  });

  it('les clés locales (séance en cours) ne passent jamais par l outbox', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:training:active-session', { sets: 3 });
    expect(await s.pendingCount()).toBe(0);
    await s.flushPendingWrites();
    expect(server.live(U1)).toEqual({});
  });
});

describe('SyncedStorage — push', () => {
  it('flush : la valeur arrive au serveur, l entrée disparaît, la version est notée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'Push' });
    await s.flushPendingWrites();
    expect(server.live(U1)).toEqual({ [SESSION('s1')]: { name: 'Push' } });
    expect(await s.pendingCount()).toBe(0);
    const v = dump(dev, 'kinetic-u-user-a', 'versions')[SESSION('s1')] as { updated_at: string };
    expect(v.updated_at).toBe(server.row(U1, SESSION('s1'))!.updated_at);
    const status = await s.getStatus();
    expect(status).toMatchObject({ state: 'synced', pending: 0, blocked: [], enabled: true });
    expect(status.lastPushAt).not.toBeNull();
  });

  it('réponse perdue après validation serveur : le réessai est idempotent (ok, même version)', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'Push' });
    server.dropResponseOnce('sync_push');
    await s.flushPendingWrites();
    const version = server.row(U1, SESSION('s1'))!.updated_at;
    expect(await s.pendingCount()).toBe(1); // le client n'a pas eu la réponse
    await s.flushPendingWrites({ ignoreBackoff: true });
    expect(await s.pendingCount()).toBe(0);
    expect(server.row(U1, SESSION('s1'))!.updated_at).toBe(version);
    expect(dump(dev, 'kinetic-u-user-a', 'recovery')).toEqual({});
  });

  it('app tuée en plein envoi : une nouvelle instance reprend l outbox persistée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'A' });
    await s.set(SESSION('s2'), { name: 'B' });
    s.dispose(); // « kill »
    const again = await dev.open(U1);
    expect(await again.pendingCount()).toBe(2);
    await again.flushPendingWrites();
    expect(Object.keys(server.live(U1)).sort()).toEqual([SESSION('s1'), SESSION('s2')]);
  });

  it('réseau coupé : backoff exponentiel, aucune perte, reprise au retour du réseau', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    let now = 1_000_000;
    const s = await dev.open(U1, { now: () => now });
    await s.set(SESSION('s1'), { name: 'A' });
    server.networkDown = true;
    await s.flushPendingWrites();
    let e = dump(dev, 'kinetic-u-user-a', 'outbox')[SESSION('s1')] as {
      attempts: number;
      nextTryAt: number;
    };
    expect(e.attempts).toBe(1);
    expect(e.nextTryAt).toBe(now + 1000);
    await s.flushPendingWrites(); // backoff non écoulé : pas d'appel
    expect(server.calls.filter((c) => c.name === 'sync_push')).toHaveLength(1);
    now += 1000;
    await s.flushPendingWrites();
    e = dump(dev, 'kinetic-u-user-a', 'outbox')[SESSION('s1')] as {
      attempts: number;
      nextTryAt: number;
    };
    expect(e.attempts).toBe(2);
    expect(e.nextTryAt).toBe(now + 2000);
    expect((await s.getStatus()).state).toBe('error');
    server.networkDown = false;
    await s.flushPendingWrites({ ignoreBackoff: true });
    expect(server.live(U1)).toEqual({ [SESSION('s1')]: { name: 'A' } });
  });

  it('hors-ligne (navigator.onLine faux) : aucun appel, état « offline »', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'A' });
    dev.online.value = false;
    await s.flushPendingWrites();
    expect(server.calls).toHaveLength(0);
    expect((await s.getStatus()).state).toBe('offline');
  });

  it('jeton expiré : refreshSession puis nouvel essai réussi', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'A' });
    server.expireSession(U1);
    await s.flushPendingWrites();
    expect(server.live(U1)).toEqual({ [SESSION('s1')]: { name: 'A' } });
  });

  it('session impossible à rafraîchir : « reconnexion nécessaire », entrée conservée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set(SESSION('s1'), { name: 'A' });
    server.expireSession(U1);
    server.refreshFails = true;
    await s.flushPendingWrites();
    expect(await s.pendingCount()).toBe(1);
    expect((await s.getStatus()).state).toBe('auth_required');
  });

  it('rejet permanent (valeur trop grosse côté serveur, quota) : entrée bloquée, visible, sans boucle', async () => {
    const server = new FakeSyncServer({ maxValueBytes: 50, maxKeys: 2 });
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:a', { text: 'x'.repeat(100) });
    await s.set('kinetic:b', 1);
    await s.set('kinetic:c', 2);
    await s.set('kinetic:d', 3);
    await s.flushPendingWrites();
    const calls = server.calls.filter((c) => c.name === 'sync_push').length;
    await s.flushPendingWrites({ ignoreBackoff: true });
    expect(server.calls.filter((c) => c.name === 'sync_push').length).toBe(calls); // plus d'envoi
    const status = await s.getStatus();
    expect(status.state).toBe('error');
    expect(status.blocked).toEqual(
      expect.arrayContaining([
        { key: 'kinetic:a', reason: 'value_too_large' },
        { key: 'kinetic:d', reason: 'quota_keys' },
      ]),
    );
    // La donnée locale est conservée.
    expect(await s.get('kinetic:d')).toBe(3);
    // Une nouvelle écriture de l'utilisateur relance l'entrée (après avoir libéré une place).
    await s.remove('kinetic:c');
    await s.flushPendingWrites();
    await s.set('kinetic:a', { text: 'ok' });
    await s.flushPendingWrites();
    expect(server.live(U1)['kinetic:a']).toEqual({ text: 'ok' });
  });

  it('valeur > 1 Mo × 1,1 : bloquée localement sans être envoyée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:big', 'y'.repeat(1_000_000));
    await s.flushPendingWrites();
    expect(server.calls.filter((c) => c.name === 'sync_push')).toHaveLength(0);
    expect((await s.getStatus()).blocked).toEqual([
      { key: 'kinetic:big', reason: 'value_too_large' },
    ]);
  });

  it('lots : 250 écritures → 3 appels de ≤ 100 éléments', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    for (let i = 0; i < 250; i++) await s.set(`kinetic:n:${i}`, i);
    await s.flushPendingWrites();
    expect(server.calls.filter((c) => c.name === 'sync_push')).toHaveLength(3);
    expect(Object.keys(server.live(U1))).toHaveLength(250);
  });

  it('écriture locale pendant l envoi : rien n est perdu, la nouvelle valeur part ensuite', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    await s.set('kinetic:xp', 10);
    const client = dev.client(U1);
    const rpc = client.rpc.bind(client);
    let injected = false;
    client.rpc = async (name, params) => {
      const r = await rpc(name, params);
      if (name === 'sync_push' && !injected) {
        injected = true;
        await s.set('kinetic:xp', 20); // l'utilisateur écrit pendant le vol
      }
      return r;
    };
    await s.flushPendingWrites();
    expect(server.live(U1)['kinetic:xp']).toBe(20);
    expect(await s.pendingCount()).toBe(0);
  });
});

describe('SyncedStorage — pull, tombstones, curseur', () => {
  it('deux appareils : création, modification et suppression se propagent', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1);
    const devB = createDevice(server);
    const b = await devB.open(U1);
    await a.set(SESSION('s1'), { name: 'A' });
    await a.flushPendingWrites();
    await b.pull();
    expect(await b.get(SESSION('s1'))).toEqual({ name: 'A' });
    await a.remove(SESSION('s1'));
    await a.flushPendingWrites();
    expect(server.row(U1, SESSION('s1'))).toMatchObject({ deleted: true, value: null });
    await b.pull();
    expect(await b.get(SESSION('s1'))).toBeNull();
    // Pas de résurrection : B ne repousse rien.
    await b.flushPendingWrites();
    expect(server.row(U1, SESSION('s1'))!.deleted).toBe(true);
    expect(devB.received.some((e) => e.name === 'kinetic:sync-applied')).toBe(true);
  });

  it('valeur JSON null vivante ≠ suppression', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1);
    const b = await createDevice(server).open(U1);
    await b.set('kinetic:program:active', { id: 'p' });
    await b.flushPendingWrites();
    await a.pull();
    await a.set('kinetic:program:active', null);
    await a.flushPendingWrites();
    expect(server.row(U1, 'kinetic:program:active')).toMatchObject({ deleted: false, value: null });
    await b.pull();
    expect(await b.keys()).toContain('kinetic:program:active');
    expect(await b.get('kinetic:program:active')).toBeNull();
  });

  it('une clé en attente n est jamais écrasée par le pull ; le conflit est résolu au push', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1);
    const devB = createDevice(server);
    const b = await devB.open(U1);
    await a.set('kinetic:prefs:units', { unit: 'kg' });
    await a.flushPendingWrites();
    await b.pull();
    await b.set('kinetic:prefs:units', { unit: 'lb' }); // B hors-ligne, en attente
    await a.set('kinetic:prefs:units', { unit: 'st' });
    await a.flushPendingWrites();
    await b.pull();
    expect(await b.get('kinetic:prefs:units')).toEqual({ unit: 'lb' });
    await b.flushPendingWrites();
    // lww : dernière écriture arrivée au serveur = B ; la valeur serveur écrasée est mise de côté.
    expect(server.live(U1)['kinetic:prefs:units']).toEqual({ unit: 'lb' });
    const recovery = await b.listRecovery();
    expect(recovery).toEqual([
      expect.objectContaining({
        key: 'kinetic:prefs:units',
        reason: 'conflict',
        value: { unit: 'st' },
      }),
    ]);
  });

  it('conflit : la stratégie du registre est appliquée (ancêtre fourni, copies, clés en plus)', async () => {
    const server = new FakeSyncServer();
    const seen: unknown[] = [];
    const keepBoth: MergeStrategy = {
      name: 'keep-both-test',
      resolve(input) {
        seen.push(input);
        const local = input.local.deleted ? null : input.local.value;
        return {
          result: input.server,
          push: false,
          extraWrites: [{ key: `${input.key}-c1`, value: local }],
          notice: 'copie créée',
        };
      },
    };
    const registry = createMergeRegistry([
      { match: 'kinetic:training:session:', strategy: keepBoth },
    ]);
    const a = await createDevice(server).open(U1, { registry });
    const b = await createDevice(server).open(U1, { registry });
    await a.set(SESSION('s1'), { name: 'v1' });
    await a.flushPendingWrites();
    await b.pull();
    await b.set(SESSION('s1'), { name: 'v2-b' });
    await a.set(SESSION('s1'), { name: 'v2-a' });
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    expect(seen[0]).toMatchObject({
      key: SESSION('s1'),
      local: { deleted: false, value: { name: 'v2-b' } },
      server: { deleted: false, value: { name: 'v2-a' } },
      ancestor: { deleted: false, value: { name: 'v1' } },
      pending: { op: 'set', seed: false, origin: 'app' },
    });
    expect(server.live(U1)).toEqual({
      [SESSION('s1')]: { name: 'v2-a' },
      [`${SESSION('s1')}-c1`]: { name: 'v2-b' },
    });
    expect(await b.get(SESSION('s1'))).toEqual({ name: 'v2-a' });
  });

  it('suppression locale en attente contre modification distante : lww repousse la suppression et garde une copie', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1, {
      registry: createMergeRegistry([], lwwStrategy),
    });
    const b = await createDevice(server).open(U1, {
      registry: createMergeRegistry([], lwwStrategy),
    });
    await a.set('kinetic:goal', { kg: 100 });
    await a.flushPendingWrites();
    await b.pull();
    await b.remove('kinetic:goal');
    await a.set('kinetic:goal', { kg: 110 });
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    expect(server.row(U1, 'kinetic:goal')!.deleted).toBe(true);
    expect((await b.listRecovery())[0]).toMatchObject({ key: 'kinetic:goal', value: { kg: 110 } });
  });

  it('page de pull appliquée en une transaction : échec IDB → rien appliqué, curseur inchangé', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1);
    const devB = createDevice(server);
    const b = await devB.open(U1, { pageSize: 2 });
    await b.pull(); // curseur initial (compte vide)
    for (let i = 0; i < 4; i++) await a.set(`kinetic:n:${i}`, i);
    await a.flushPendingWrites();
    await b.pull();
    const cursor = dump(devB, 'kinetic-u-user-a', 'meta')['cursor'];
    await a.set('kinetic:n:9', 9);
    await a.set('kinetic:n:8', 8);
    await a.flushPendingWrites();
    devB.fake.failNext((op) => op.kind === 'put' && op.key === 'kinetic:n:8', 'QuotaExceededError');
    await b.pull();
    expect(dump(devB, 'kinetic-u-user-a', 'meta')['cursor']).toEqual(cursor);
    expect(await b.get('kinetic:n:9')).toBeNull();
    await b.pull();
    expect(await b.get('kinetic:n:9')).toBe(9);
    expect(await b.get('kinetic:n:8')).toBe(8);
  });

  it('pagination : 1200 clés avec versions toutes distinctes, pages de 500', async () => {
    const server = new FakeSyncServer();
    for (let i = 0; i < 1200; i++) server.seed(U1, `kinetic:n:${i}`, i);
    const devB = createDevice(server);
    const b = await devB.open(U1);
    await b.pull();
    expect((await b.keys()).length).toBe(1200);
    expect(server.calls.filter((c) => c.name === 'sync_pull_v2')).toHaveLength(3);
  });

  it('resync_required (tombstones purgées) : pull complet, clés orphelines mises de côté', async () => {
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1);
    const devB = createDevice(server);
    const b = await devB.open(U1);
    await a.set('kinetic:x', 1);
    await a.set('kinetic:y', 2);
    await a.flushPendingWrites();
    await b.pull();
    await a.remove('kinetic:x');
    await a.flushPendingWrites();
    server.advance(200 * 24 * 3600 * 1000);
    server.purge(180 * 24 * 3600 * 1000);
    await b.set('kinetic:mine', 'pending'); // en attente : jamais mise de côté
    await b.pull();
    expect(await b.get('kinetic:x')).toBeNull();
    expect(await b.get('kinetic:y')).toBe(2);
    expect(await b.get('kinetic:mine')).toBe('pending');
    const rec = await b.listRecovery();
    expect(rec).toEqual([
      expect.objectContaining({ key: 'kinetic:x', reason: 'resync', value: 1 }),
    ]);
    expect((await b.getStatus()).recovery).toBe(1);
    expect(devB.received.some((e) => e.name === 'kinetic:notify')).toBe(true);
    // « Restaurer » : réécriture normale via l'outbox.
    await b.restoreRecovery(rec[0]!.id);
    await b.flushPendingWrites();
    expect(server.live(U1)['kinetic:x']).toBe(1);
    expect((await b.getStatus()).recovery).toBe(0);
  });

  it('curseur dans le futur (ancienne version) : resync', async () => {
    const server = new FakeSyncServer();
    const devB = createDevice(server);
    const b = await devB.open(U1);
    server.seed(U1, 'kinetic:x', 1);
    await b.pull();
    // Curseur empoisonné (2099) écrit par une ancienne version.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = devB.factory.open('kinetic-u-user-a');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(['meta'], 'readwrite');
      tx.objectStore('meta').put({ since: '2099-01-01T00:00:00+00:00', afterKey: '' }, 'cursor');
      tx.oncomplete = () => resolve();
    });
    db.close();
    server.seed(U1, 'kinetic:y', 2);
    await b.pull();
    expect(await b.get('kinetic:y')).toBe(2);
  });

  it('restauration forcée (profil) : pull complet, entrées en attente conservées', async () => {
    const server = new FakeSyncServer();
    const b = await createDevice(server).open(U1);
    server.seed(U1, 'kinetic:x', 1);
    await b.pull();
    await b.set('kinetic:x', 5);
    await b.syncFromRemote({ force: true });
    expect(server.live(U1)['kinetic:x']).toBe(5);
  });
});

describe('SyncedStorage — comptes, isolement, cycle de vie', () => {
  it('une base par compte : les données et l outbox de A ne sont jamais visibles ni poussées dans B', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const a = await dev.open(U1);
    await a.set(SESSION('a1'), { by: 'A' });
    server.networkDown = true;
    await a.flushPendingWrites();
    a.dispose(); // déconnexion de A, entrée encore en attente
    server.networkDown = false;
    server.seed(U2, SESSION('b-old'), { by: 'B' });
    const b = await dev.open(U2);
    expect(await b.get(SESSION('a1'))).toBeNull();
    await b.sync();
    expect(server.live(U2)).toEqual({ [SESSION('b-old')]: { by: 'B' } });
    expect(await b.get(SESSION('b-old'))).toEqual({ by: 'B' });
    b.dispose();
    // A se reconnecte : son entrée part dans SON compte.
    const a2 = await dev.open(U1);
    await a2.sync({ ignoreBackoff: true }); // démarrage : réessai immédiat
    expect(server.live(U1)).toEqual({ [SESSION('a1')]: { by: 'A' } });
  });

  it('base dont le propriétaire ne correspond pas : refusée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const a = await dev.open(U1);
    a.dispose();
    // Base renommée / corrompue : propriétaire différent.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = dev.factory.open('kinetic-u-user-a');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(['meta'], 'readwrite');
      tx.objectStore('meta').put('someone-else', 'owner');
      tx.oncomplete = () => resolve();
    });
    db.close();
    await expect(dev.open(U1)).rejects.toBeInstanceOf(OwnerMismatchError);
  });

  it('mode invité : base kinetic-guest, aucune outbox, aucun appel réseau', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const g = await dev.open('guest');
    await g.set('kinetic:xp', 10);
    expect(dump(dev, 'kinetic-guest', 'outbox')).toEqual({});
    await g.sync();
    expect(server.calls).toHaveLength(0);
    expect((await g.getStatus()).enabled).toBe(false);
  });

  it('liaison invité → compte : rien d automatique, fusion explicite via l outbox', async () => {
    const server = new FakeSyncServer();
    server.seed(U1, 'kinetic:xp', 100);
    const dev = createDevice(server);
    const g = await dev.open('guest');
    await g.set(SESSION('g1'), { name: 'Invité' });
    await g.set('kinetic:xp', 30);
    g.dispose();
    const a = await dev.open(U1);
    await a.sync();
    expect(await a.get(SESSION('g1'))).toBeNull(); // pas de fusion silencieuse
    expect(await a.guestDataSummary()).toEqual({ count: 2, decision: null });
    await a.importGuestData();
    await a.flushPendingWrites();
    expect(server.live(U1)[SESSION('g1')]).toEqual({ name: 'Invité' });
    expect(await a.guestDataSummary()).toEqual({ count: 2, decision: 'linked' });
    // La base invité est conservée intacte.
    expect(dump(dev, 'kinetic-guest', 'kv')[SESSION('g1')]).toEqual({ name: 'Invité' });
  });

  it('refus de la liaison : base invité intacte, décision mémorisée', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const g = await dev.open('guest');
    await g.set('kinetic:xp', 30);
    g.dispose();
    const a = await dev.open(U1);
    await a.sync();
    await a.declineGuestData();
    expect(await a.guestDataSummary()).toEqual({ count: 1, decision: 'declined' });
    expect(server.live(U1)).toEqual({});
  });

  it('import invité avant le premier pull : refusé (jamais d écrasement du cloud)', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const g = await dev.open('guest');
    await g.set('kinetic:xp', 30);
    g.dispose();
    const a = await dev.open(U1);
    await expect(a.importGuestData()).rejects.toThrow(/initiale/);
  });

  it('deux onglets sur la même base : aucune écriture perdue', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const t1 = await dev.open(U1);
    const t2 = await dev.open(U1);
    await Promise.all([
      t1.set('kinetic:a', 1),
      t2.set('kinetic:b', 2),
      t1.set('kinetic:c', 3),
      t2.set('kinetic:a', 4),
    ]);
    await Promise.all([t1.flushPendingWrites(), t2.flushPendingWrites()]);
    expect(server.live(U1)).toEqual({ 'kinetic:a': 4, 'kinetic:b': 2, 'kinetic:c': 3 });
  });
});

describe('SyncedStorage — effacer / supprimer', () => {
  it('« Effacer les données de cet appareil » : local seulement, le cloud reste, pull complet ensuite', async () => {
    const server = new FakeSyncServer();
    const s = await createDevice(server).open(U1);
    await s.set('kinetic:x', 1);
    await s.flushPendingWrites();
    await s.clearDevice();
    expect(await s.keys()).toEqual([]);
    expect(server.live(U1)).toEqual({ 'kinetic:x': 1 });
    await s.pull();
    expect(await s.get('kinetic:x')).toBe(1);
  });

  it('« Supprimer toutes mes données cloud » hors-ligne : en attente persistée, jamais de faux succès', async () => {
    const server = new FakeSyncServer();
    const devA = createDevice(server);
    const a = await devA.open(U1);
    const b = await createDevice(server).open(U1);
    await a.set('kinetic:x', 1);
    await a.set('kinetic:y', 2);
    await a.flushPendingWrites();
    await b.pull();
    server.networkDown = true;
    await expect(a.deleteAllCloudData()).rejects.toThrow();
    expect((await a.getStatus()).deleteAllPending).toBe(true);
    expect(server.live(U1)).toEqual({ 'kinetic:x': 1, 'kinetic:y': 2 });
    a.dispose();
    // Redémarrage : la demande est toujours là et part avant le reste.
    server.networkDown = false;
    const a2 = await devA.open(U1);
    await a2.set('kinetic:after', 'nouveau');
    await a2.flushPendingWrites({ ignoreBackoff: true });
    expect(server.live(U1)).toEqual({ 'kinetic:after': 'nouveau' });
    expect(await a2.get('kinetic:x')).toBeNull();
    expect((await a2.getStatus()).deleteAllPending).toBe(false);
    await b.pull();
    expect(await b.get('kinetic:x')).toBeNull();
    expect(await b.get('kinetic:y')).toBeNull();
  });

  it('« Supprimer toutes mes données cloud » en ligne : résout après la réponse du serveur', async () => {
    const server = new FakeSyncServer();
    const s = await createDevice(server).open(U1);
    await s.set('kinetic:x', 1);
    await s.flushPendingWrites();
    await s.deleteAllCloudData();
    expect(server.live(U1)).toEqual({});
    expect(await s.keys()).toEqual([]);
  });
});

describe('SyncedStorage — compatibilité', () => {
  it('serveur non migré (PGRST202) : repli sur upsert / delete / sync_pull', async () => {
    const server = new FakeSyncServer({ migrated: false });
    const a = await createDevice(server).open(U1);
    const b = await createDevice(server).open(U1);
    await a.set('kinetic:x', 1);
    await a.flushPendingWrites();
    expect(server.live(U1)).toEqual({ 'kinetic:x': 1 });
    await b.pull();
    expect(await b.get('kinetic:x')).toBe(1);
    await a.remove('kinetic:x');
    await a.flushPendingWrites();
    expect(server.live(U1)).toEqual({});
  });

  it('ancien client (HybridStorage + SupabaseStorage) et nouveau client coexistent', async () => {
    const { HybridStorage, SupabaseStorage } = await import('@kinetic/adapters-web');
    const { InMemoryStorage } = await import('@test-helpers/stubs.ts');
    const server = new FakeSyncServer();
    const oldRemote = new SupabaseStorage(server.client(U1) as never, U1);
    const old = new HybridStorage(new InMemoryStorage(), oldRemote, { scheduleRetry: null });
    await old.ready;
    const fresh = await createDevice(server).open(U1);

    await old.set(SESSION('old'), { by: 'old' });
    await old.flushPendingWrites();
    await fresh.pull();
    expect(await fresh.get(SESSION('old'))).toEqual({ by: 'old' });

    // Suppression par l'ancien client → tombstone → propagée au nouveau.
    await old.remove(SESSION('old'));
    await old.flushPendingWrites();
    await fresh.pull();
    expect(await fresh.get(SESSION('old'))).toBeNull();

    // Écriture du nouveau client → visible par l'ancien (sync_pull sans tombstones).
    await fresh.set(SESSION('new'), { by: 'new' });
    await fresh.flushPendingWrites();
    await old.syncFromRemote();
    expect(await old.get(SESSION('new'))).toEqual({ by: 'new' });
    old.dispose();
  });
});

describe('SyncedStorage — état publié', () => {
  it('publie kinetic:sync-status avec le nombre d entrées en attente', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    const seen: number[] = [];
    s.onStatus((st) => seen.push(st.pending));
    await s.set('kinetic:x', 1);
    await s.publishStatus();
    expect(seen.at(-1)).toBe(1);
    await s.flushPendingWrites();
    await s.publishStatus();
    expect(seen.at(-1)).toBe(0);
    expect(dev.received.some((e) => e.name === 'kinetic:sync-status')).toBe(true);
  });

  it('SyncedStorage.open est exporté et ouvre la base du compte', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open(U1);
    expect(s).toBeInstanceOf(SyncedStorage);
    expect(s.dbName).toBe('kinetic-u-user-a');
  });
});

describe('SyncedStorage — robustesse supplémentaire', () => {
  it('client Supabase partagé passé sur un autre compte : la base de A ne pousse RIEN dans B', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const shared = server.client(U1);
    const { SupabaseSyncRemote } = await import('@kinetic/adapters-web');
    const remoteA = new SupabaseSyncRemote(shared as never, U1, () => shared.uid);
    const a = await SyncedStorage.open({
      owner: U1,
      remote: remoteA,
      factory: dev.factory,
      autoSync: false,
      eventTarget: dev.events,
    });
    await a.set(SESSION('a1'), { by: 'A' });
    shared.uid = U2; // la session du client est maintenant celle de B
    await a.flushPendingWrites();
    expect(server.live(U2)).toEqual({});
    expect(server.live(U1)).toEqual({});
    expect(await a.pendingCount()).toBe(1);
    expect((await a.getStatus()).state).toBe('auth_required');
    shared.uid = U1;
    await a.flushPendingWrites({ ignoreBackoff: true });
    expect(server.live(U1)).toEqual({ [SESSION('a1')]: { by: 'A' } });
  });

  it('registre métier (domainMergeRegistry) : une séance modifiée des deux côtés n est jamais perdue', async () => {
    const { domainMergeRegistry } = await import('@kinetic/core');
    const server = new FakeSyncServer();
    const a = await createDevice(server).open(U1, { registry: domainMergeRegistry });
    const b = await createDevice(server).open(U1, { registry: domainMergeRegistry });
    const base = { id: 's1', name: 'Push', date: '2026-11-24', exercises: [] };
    await a.set(SESSION('s1'), base);
    await a.flushPendingWrites();
    await b.pull();
    await a.set(SESSION('s1'), { ...base, name: 'Push (A)' });
    await b.set(SESSION('s1'), { ...base, name: 'Push (B)' });
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    await b.flushPendingWrites();
    const live = server.live(U1);
    const names = Object.entries(live)
      .filter(([k]) => k.startsWith('kinetic:training:session:'))
      .map(([, v]) => (v as { name: string }).name);
    expect(names.some((n) => n.includes('Push (A)'))).toBe(true);
    expect(names.some((n) => n.includes('Push (B)'))).toBe(true);
    await a.pull();
    expect((await a.keys()).filter((k) => k.startsWith('kinetic:training:session:')).length).toBe(
      names.length,
    );
  });

  it('conflit dont la valeur serveur est omise (réponse > 4 Mo) : relue puis résolue', async () => {
    const server = new FakeSyncServer();
    const big = (n: number) => ({ blob: String(n).repeat(900_000) });
    for (let i = 0; i < 6; i++) server.seed(U1, `kinetic:big:${i}`, big(i));
    const s = await createDevice(server).open(U1, {
      registry: createMergeRegistry([], lwwStrategy),
    });
    for (let i = 0; i < 6; i++) await s.set(`kinetic:big:${i}`, { small: i }); // base null → conflits
    await s.flushPendingWrites();
    await s.flushPendingWrites({ ignoreBackoff: true });
    for (let i = 0; i < 6; i++) expect(server.live(U1)[`kinetic:big:${i}`]).toEqual({ small: i });
    // Chaque grosse valeur serveur écrasée est mise de côté, y compris celles omises.
    const rec = await s.listRecovery();
    expect(rec.filter((r) => r.reason === 'conflict')).toHaveLength(6);
  });

  it('synchro automatique : une écriture part d elle-même après l anti-rebond', async () => {
    const server = new FakeSyncServer();
    const s = await createDevice(server).open(U1, { autoSync: true, debounceMs: 5 });
    s.start();
    await new Promise((r) => setTimeout(r, 30));
    await s.set('kinetic:x', 1);
    for (let i = 0; i < 50 && server.live(U1)['kinetic:x'] === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.live(U1)['kinetic:x']).toBe(1);
    s.dispose();
  });
});
