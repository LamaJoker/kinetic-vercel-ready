/**
 * Revue « compatibilité / migration » : passage de l'ancienne version de l'app
 * (HybridStorage + base `keyval-store`) à la nouvelle (SyncedStorage, base par compte).
 *
 * Code réel : ancien client `HybridStorage` + `SupabaseStorage`, `SyncedStorage` +
 * `SupabaseSyncRemote`, règles de fusion par domaine (`lib/sync-merge`), fonctions de
 * l'app (`saveSession`, `loadSessions`). Serveur : sémantique SQL de la migration 010.
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS, jsonEqual, type StoragePort } from '@kinetic/core';
import {
  HybridStorage,
  SupabaseStorage,
  SupabaseSyncRemote,
  openLegacyFallbackStorage,
  SyncedStorage,
} from '@kinetic/adapters-web';
import {
  FakeClock,
  InMemoryStorage,
  SequentialIdGenerator,
  SpyNotifier,
} from '@test-helpers/stubs.ts';
import { createDepsManager } from '../../apps/web/src/deps.factory';
import { createFakeIndexedDB } from '../support/fake-indexeddb';
import { FakeSyncServer } from '../support/fake-sync-server';
import { syncMerge } from '../../apps/web/src/lib/sync-merge';
import {
  deleteSession,
  loadSessions,
  saveSession,
  sessionStorageKey,
} from '../../apps/web/src/lib/training/storage';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types';

const ALICE = 'user-alice';
const SESSION_PREFIX = STORAGE_KEYS.TRAINING_SESSION_PREFIX;

function workout(id: string, name: string, reps = 5): WorkoutSession {
  const at = '2026-11-24T08:00:00.000Z';
  return {
    id,
    name,
    startedAt: at,
    endedAt: '2026-11-24T09:00:00.000Z',
    entries: [
      {
        exerciseId: 'squat',
        sets: [{ setIndex: 0, reps, weightKg: 100, rpe: 8, performedAt: at }],
      },
    ],
  };
}

function cloudSessions(server: FakeSyncServer, uid: string): Record<string, WorkoutSession> {
  const out: Record<string, WorkoutSession> = {};
  for (const [k, v] of Object.entries(server.live(uid))) {
    if (k.startsWith(SESSION_PREFIX)) out[(v as WorkoutSession).id] = v as WorkoutSession;
  }
  return out;
}

/** Ancien client réel (version installée avant la mise à jour). */
async function legacyClient(
  server: FakeSyncServer,
  uid: string,
): Promise<{ local: InMemoryStorage; hybrid: HybridStorage }> {
  const local = new InMemoryStorage();
  const hybrid = new HybridStorage(local, new SupabaseStorage(server.client(uid) as never, uid), {
    scheduleRetry: null,
  });
  await hybrid.ready;
  return { local, hybrid };
}

/** Recopie le contenu de l'ancien stockage dans la vraie base `keyval-store` de l'appareil. */
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

function openNew(server: FakeSyncServer, idb: IDBFactory, uid: string): Promise<SyncedStorage> {
  return SyncedStorage.open({
    owner: uid,
    remote: new SupabaseSyncRemote(server.client(uid) as never, uid),
    factory: idb,
    autoSync: false,
    eventTarget: new EventTarget(),
    isOnline: () => true,
    loadMerge: async () => syncMerge,
  });
}

describe('Migration : ancienne base PÉRIMÉE (téléphone pas ouvert depuis longtemps)', () => {
  it('les valeurs déjà synchronisées mais périmées n écrasent pas le cloud et ne créent pas de fausse copie « (conflit) »', async () => {
    const server = new FakeSyncServer();

    // ── Téléphone A, ancienne version : séance et plan nutrition envoyés puis tirés ──
    const a = await legacyClient(server, ALICE);
    await saveSession(a.hybrid, workout('w1', 'Jambes', 5));
    await a.hybrid.set(STORAGE_KEYS.NUTRITION_PLAN, { kcal: 2000, protein: 120 });
    await a.hybrid.flushPendingWrites();
    await a.hybrid.syncFromRemote(); // curseur serveur posé : A est à jour
    expect(await a.hybrid.pendingCount()).toBe(0);
    a.hybrid.dispose();

    // ── Téléphone B, nouvelle version : modifie la séance et le plan ──
    server.advance(60_000);
    const { factory: idbB } = createFakeIndexedDB();
    const b = await openNew(server, idbB, ALICE);
    await b.sync({ ignoreBackoff: true });
    await saveSession(b, workout('w1', 'Jambes', 8));
    await b.set(STORAGE_KEYS.NUTRITION_PLAN, { kcal: 2500, protein: 150 });
    await b.sync({ ignoreBackoff: true });
    expect(await b.pendingCount()).toBe(0);

    // ── Téléphone A : mise à jour de l'app (son ancienne base n'a pas vu ces changements) ──
    server.advance(60_000);
    const { factory: idbA } = createFakeIndexedDB();
    await writeLegacyDb(idbA, a.local.snapshot());
    const newA = await openNew(server, idbA, ALICE);
    expect(newA.migration).toMatchObject({ status: 'migrated' });
    await newA.sync({ ignoreBackoff: true });
    await newA.sync({ ignoreBackoff: true });

    // Le cloud garde les modifications de B : rien d'ancien ne les écrase.
    const cloud = cloudSessions(server, ALICE);
    expect(Object.keys(cloud)).toEqual(['w1']); // aucune copie « (conflit) » parasite
    expect(cloud['w1']!.entries[0]!.sets[0]!.reps).toBe(8);
    expect(server.live(ALICE)[STORAGE_KEYS.NUTRITION_PLAN]).toEqual({ kcal: 2500, protein: 150 });
    // A affiche l'état du cloud.
    expect((await loadSessions(newA)).map((s) => s.entries[0]!.sets[0]!.reps)).toEqual([8]);
    expect(await newA.get(STORAGE_KEYS.NUTRITION_PLAN)).toEqual({ kcal: 2500, protein: 150 });
    expect(await newA.pendingCount()).toBe(0);
    // Aucune perte : l'ancienne valeur locale reste récupérable.
    const recovered = (await newA.listRecovery()).map((r) => r.key);
    expect(recovered).toContain(sessionStorageKey('w1'));
    expect(recovered).toContain(STORAGE_KEYS.NUTRITION_PLAN);
    newA.dispose();
    b.dispose();
  });

  it('une valeur écrite HORS outbox par l ancien client (démarrage hors-ligne, F10) après son dernier pull est toujours envoyée', async () => {
    const server = new FakeSyncServer();
    const a = await legacyClient(server, ALICE);
    await saveSession(a.hybrid, workout('w1', 'Jambes', 5));
    await a.hybrid.flushPendingWrites();
    await a.hybrid.syncFromRemote();
    a.hybrid.dispose();
    // Ancienne version lancée hors-ligne : IdbStorage nu, aucune entrée d'outbox (F10).
    await saveSession(a.local, workout('w1', 'Jambes', 9));
    await saveSession(a.local, workout('w2', 'Dos', 7));

    server.advance(60_000);
    const { factory: idbA } = createFakeIndexedDB();
    await writeLegacyDb(idbA, a.local.snapshot());
    const newA = await openNew(server, idbA, ALICE);
    await newA.sync({ ignoreBackoff: true });
    await newA.sync({ ignoreBackoff: true });

    const cloud = cloudSessions(server, ALICE);
    expect(cloud['w2']?.name).toBe('Dos');
    // La modification locale n'est pas perdue (envoyée, ou copie conservée dans le cloud).
    const reps = Object.values(cloud).map((s) => s.entries[0]!.sets[0]!.reps);
    expect(reps).toContain(9);
    expect(await newA.pendingCount()).toBe(0);
    newA.dispose();
  });

  it('ancienne outbox (modification et suppression hors-ligne) sur des clés que personne n a touchées depuis : appliquées telles quelles, sans fausse copie « (conflit) » ni suppression annulée', async () => {
    const server = new FakeSyncServer();
    const a = await legacyClient(server, ALICE);
    await saveSession(a.hybrid, workout('w1', 'Jambes', 5));
    await saveSession(a.hybrid, workout('w2', 'Dos', 5));
    await a.hybrid.flushPendingWrites();
    await a.hybrid.syncFromRemote();
    // Ancienne version, hors-ligne : modification de w1, suppression de w2 (dans l'outbox).
    server.networkDown = true;
    await saveSession(a.hybrid, workout('w1', 'Jambes', 10));
    await deleteSession(a.hybrid, 'w2');
    await a.hybrid.flushPendingWrites();
    a.hybrid.dispose();
    server.networkDown = false;
    expect(await a.hybrid.pendingCount()).toBe(2);

    server.advance(60_000);
    const { factory: idbA } = createFakeIndexedDB();
    await writeLegacyDb(idbA, a.local.snapshot());
    const newA = await openNew(server, idbA, ALICE);
    await newA.sync({ ignoreBackoff: true });
    await newA.sync({ ignoreBackoff: true });

    const cloud = cloudSessions(server, ALICE);
    expect(Object.keys(cloud)).toEqual(['w1']);
    expect(cloud['w1']!.entries[0]!.sets[0]!.reps).toBe(10);
    expect(server.row(ALICE, sessionStorageKey('w2'))?.deleted).toBe(true);
    expect((await loadSessions(newA)).map((s) => s.id)).toEqual(['w1']);
    expect(await newA.pendingCount()).toBe(0);
    expect(await newA.listRecovery()).toEqual([]);
    newA.dispose();
  });

  it('ancienne outbox sur une clé modifiée ailleurs APRÈS le dernier pull : vrai conflit, les deux versions sont gardées', async () => {
    const server = new FakeSyncServer();
    const a = await legacyClient(server, ALICE);
    await saveSession(a.hybrid, workout('w1', 'Jambes', 5));
    await a.hybrid.flushPendingWrites();
    await a.hybrid.syncFromRemote();
    server.networkDown = true;
    await saveSession(a.hybrid, workout('w1', 'Jambes', 10));
    await a.hybrid.flushPendingWrites();
    a.hybrid.dispose();
    server.networkDown = false;

    server.advance(60_000);
    const { factory: idbB } = createFakeIndexedDB();
    const b = await openNew(server, idbB, ALICE);
    await b.sync({ ignoreBackoff: true });
    await saveSession(b, workout('w1', 'Jambes', 3));
    await b.sync({ ignoreBackoff: true });

    server.advance(60_000);
    const { factory: idbA } = createFakeIndexedDB();
    await writeLegacyDb(idbA, a.local.snapshot());
    const newA = await openNew(server, idbA, ALICE);
    await newA.sync({ ignoreBackoff: true });
    await newA.sync({ ignoreBackoff: true });

    const reps = Object.values(cloudSessions(server, ALICE))
      .map((s) => s.entries[0]!.sets[0]!.reps)
      .sort((x, y) => x - y);
    expect(reps).toEqual([3, 10]);
    expect(await newA.pendingCount()).toBe(0);
    newA.dispose();
    b.dispose();
  });
});

describe('Retour arrière vers l ancienne version après la migration', () => {
  it('l ancienne outbox, déjà reprise par la nouvelle version, n est pas rejouée : elle n écrase pas les modifications faites depuis', async () => {
    const server = new FakeSyncServer();
    const a = await legacyClient(server, ALICE);
    await saveSession(a.hybrid, workout('w1', 'Jambes', 5));
    await saveSession(a.hybrid, workout('w2', 'Dos', 5));
    await a.hybrid.flushPendingWrites();
    await a.hybrid.syncFromRemote();
    server.networkDown = true;
    await saveSession(a.hybrid, workout('w1', 'Jambes', 10)); // en attente (ancienne outbox)
    await a.hybrid.flushPendingWrites();
    a.hybrid.dispose();
    server.networkDown = false;

    // Mise à jour : la nouvelle version reprend l'outbox et l'envoie.
    server.advance(60_000);
    const { factory: idbA, fake } = createFakeIndexedDB();
    await writeLegacyDb(idbA, a.local.snapshot());
    const newA = await openNew(server, idbA, ALICE);
    await newA.sync({ ignoreBackoff: true });
    expect(cloudSessions(server, ALICE)['w1']!.entries[0]!.sets[0]!.reps).toBe(10);
    // L'utilisateur continue avec la nouvelle version : w1 modifiée, w2 supprimée.
    server.advance(60_000);
    await saveSession(newA, workout('w1', 'Jambes', 12));
    await newA.sync({ ignoreBackoff: true });
    expect(await newA.pendingCount()).toBe(0);
    newA.dispose();

    // Retour arrière : l'ancienne version relit `keyval-store` (conservée pour ça).
    const rolledBack = new InMemoryStorage();
    for (const [k, v] of fake.dump('keyval-store', 'keyval')) {
      if (typeof k === 'string') await rolledBack.set(k, v);
    }
    server.advance(60_000);
    const old = new HybridStorage(
      rolledBack,
      new SupabaseStorage(server.client(ALICE) as never, ALICE),
      { scheduleRetry: null },
    );
    await old.ready;
    await old.syncFromRemote();
    await old.flushPendingWrites({ ignoreBackoff: true });
    old.dispose();

    // La modification faite avec la nouvelle version n'est pas écrasée par l'ancienne outbox.
    expect(cloudSessions(server, ALICE)['w1']!.entries[0]!.sets[0]!.reps).toBe(12);
    expect(
      (await rolledBack.get<WorkoutSession>(sessionStorageKey('w1')))!.entries[0]!.sets[0]!.reps,
    ).toBe(12);
  });
});

describe('Repli sur l ancienne base quand la base du compte ne s ouvre pas', () => {
  it('séance enregistrée pendant le repli : retrouvée et envoyée au lancement suivant (jamais perdue en silence)', async () => {
    const server = new FakeSyncServer();
    const { factory: idb } = createFakeIndexedDB();
    const marks = new Set<string>();
    let failOpen = false;
    const launch = async (): Promise<StoragePort> => {
      const manager = createDepsManager({
        createLocalStorage: (owner) => openLegacyFallbackStorage({ factory: idb, owner }),
        createClock: () => new FakeClock(),
        createIdGen: () => new SequentialIdGenerator(),
        createNotifier: () => new SpyNotifier(),
        createNoopDailyLogSync: () => ({ upsert: async () => undefined }),
        createDailyLogSync: () => ({ upsert: async () => undefined }),
        hasRemoteSync: true,
        getSessionUserId: () => ALICE,
        fallbackMarks: marks,
        openStorage: async (owner, opts) => {
          if (failOpen) throw Object.assign(new Error('Connection lost'), { name: 'UnknownError' });
          return SyncedStorage.open({
            owner,
            remote: new SupabaseSyncRemote(server.client(owner) as never, owner),
            factory: idb,
            autoSync: false,
            eventTarget: new EventTarget(),
            isOnline: () => true,
            loadMerge: async () => syncMerge,
            recoverFallbackWrites: opts.recoverFallbackWrites,
          });
        },
      });
      return (await manager.getDeps()).storage;
    };

    // 1er lancement : base du compte, une séance synchronisée.
    const first = (await launch()) as SyncedStorage;
    await saveSession(first, workout('w1', 'Jambes', 5));
    await first.set(STORAGE_KEYS.NUTRITION_PLAN, { kcal: 2500 });
    await first.sync({ ignoreBackoff: true });
    first.dispose();

    // 2e lancement : la base du compte ne s'ouvre pas (WebKit) → repli.
    failOpen = true;
    const fallback = await launch();
    expect(fallback).not.toBeInstanceOf(SyncedStorage);
    await saveSession(fallback, workout('w2', 'Dos', 7));
    // Valeur calculée sur l'ancienne base (ici absente : valeur par défaut).
    await fallback.set(STORAGE_KEYS.NUTRITION_PLAN, { kcal: 2000 });
    expect((await loadSessions(fallback)).map((s) => s.id)).toContain('w2');

    // 3e lancement : la base du compte s'ouvre de nouveau.
    failOpen = false;
    const third = (await launch()) as SyncedStorage;
    expect((await loadSessions(third)).map((s) => s.id).sort()).toEqual(['w1', 'w2']);
    await third.sync({ ignoreBackoff: true });
    expect(Object.keys(cloudSessions(server, ALICE)).sort()).toEqual(['w1', 'w2']);
    expect(await third.pendingCount()).toBe(0);
    expect(marks.size).toBe(0);
    // Autre clé : rien n'est écrasé, la valeur du repli est mise de côté (restaurable).
    expect(await third.get(STORAGE_KEYS.NUTRITION_PLAN)).toEqual({ kcal: 2500 });
    expect(server.live(ALICE)[STORAGE_KEYS.NUTRITION_PLAN]).toEqual({ kcal: 2500 });
    expect(
      (await third.listRecovery()).some(
        (r) => r.key === STORAGE_KEYS.NUTRITION_PLAN && jsonEqual(r.value, { kcal: 2000 }),
      ),
    ).toBe(true);
    third.dispose();

    // Rien n'est réimporté une seconde fois.
    const fourth = (await launch()) as SyncedStorage;
    expect(await fourth.pendingCount()).toBe(0);
    fourth.dispose();
  });
});
