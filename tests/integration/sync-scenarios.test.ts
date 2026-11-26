/**
 * Scénarios de synchronisation réalistes, de bout en bout, avec le code RÉEL de l'app :
 * - choix de la base par `createDepsManager` (deps.factory), session lue localement ;
 * - `SyncedStorage` + `SupabaseSyncRemote` (adaptateur) ;
 * - fonctions de l'app `saveSession` / `deleteSession` / `loadSessions` /
 *   `loadTemplates` / `saveTemplates` / séance en cours (`writeActiveSession`) ;
 * - règles de fusion par domaine du core (`lib/sync-merge`, chargées à la demande) ;
 * - ancien client réel (`HybridStorage` + `SupabaseStorage`) pour la migration.
 *
 * Chaque « téléphone » a son propre IndexedDB en mémoire fidèle (tests/support/
 * fake-indexeddb), son horloge, son réseau (coupure franche, coupure au milieu d'un
 * lot, réponse perdue) et un client Supabase partagé dont la session suit le compte
 * connecté, comme dans l'app. Le serveur (tests/support/fake-sync-server) applique
 * exactement la sémantique SQL de la migration 010 (versions, tombstones, conflits,
 * quotas, pagination, purge). Rien de ce qui est vérifié n'est mocké.
 */
import { describe, expect, it } from 'vitest';
import { deleteCollectionItems, STORAGE_KEYS, type StoragePort } from '@kinetic/core';
import {
  HybridStorage,
  SupabaseStorage,
  SupabaseSyncRemote,
  SyncedStorage,
} from '@kinetic/adapters-web';
import {
  InMemoryStorage,
  FakeClock,
  SequentialIdGenerator,
  SpyNotifier,
} from '@test-helpers/stubs.ts';
import { createFakeIndexedDB, type FakeIndexedDB } from '../support/fake-indexeddb';
import { FakeSyncServer, type FakeSupabaseClient } from '../support/fake-sync-server';
import { createDepsManager, type DepsManager } from '../../apps/web/src/deps.factory';
import { syncMerge } from '../../apps/web/src/lib/sync-merge';
import {
  deleteSession,
  loadSessions,
  loadTemplates,
  saveSession,
  saveTemplates,
  sessionStorageKey,
} from '../../apps/web/src/lib/training/storage';
import {
  loadActiveSession,
  snapshotActiveSession,
  writeActiveSession,
} from '../../apps/web/src/lib/training/active-session';
import type { WorkoutSession, WorkoutTemplate } from '../../apps/web/src/lib/training/types';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const SESSION_PREFIX = STORAGE_KEYS.TRAINING_SESSION_PREFIX;

type Reply = ReturnType<FakeSupabaseClient['exec']>;

// ─── Téléphone simulé ──────────────────────────────────────────────────────

interface Net {
  /** Le réseau répond (sinon : `fetch failed`, status 0). */
  up: boolean;
  /** Coupure programmée : après N appels réussis de `cutOn`, le réseau tombe. */
  cutAfter: number | null;
  cutOn: string;
  /** Appelé après chaque appel réussi (autre appareil qui écrit entre deux pages…). */
  afterCall: ((name: string) => void) | null;
}

class Phone {
  readonly idb: IDBFactory;
  readonly fake: FakeIndexedDB;
  readonly events = new EventTarget();
  readonly notices: string[] = [];
  /** Session Supabase enregistrée sur l'appareil (`kinetic-auth`), même expirée. */
  session: string | null = null;
  /** `navigator.onLine`. */
  navigatorOnline = true;
  readonly net: Net = { up: true, cutAfter: null, cutOn: 'sync_push', afterCall: null };
  readonly clock = { ms: T0 };
  /** Client Supabase PARTAGÉ de l'app : sa session suit le compte connecté. */
  readonly client: FakeSupabaseClient;
  private manager: DepsManager | null = null;
  private current: SyncedStorage | null = null;
  readonly opened: SyncedStorage[] = [];

  constructor(
    readonly server: FakeSyncServer,
    readonly name: string,
    private readonly tuning: { pageSize?: number; batchMaxItems?: number } = {},
  ) {
    const { factory, fake } = createFakeIndexedDB();
    this.idb = factory;
    this.fake = fake;
    this.client = server.client(null);
    const exec = this.client.exec.bind(this.client);
    this.client.exec = (callName: string, run: () => unknown): Reply => {
      if (!this.net.up) {
        server.calls.push({ name: callName, user: this.client.uid });
        return { data: null, error: { code: '', message: 'TypeError: fetch failed' }, status: 0 };
      }
      const reply = exec(callName, run);
      if (this.net.cutAfter !== null && callName === this.net.cutOn) {
        this.net.cutAfter -= 1;
        if (this.net.cutAfter <= 0) {
          this.net.cutAfter = null;
          this.net.up = false;
        }
      }
      this.net.afterCall?.(callName);
      return reply;
    };
    this.events.addEventListener(STORAGE_KEYS.EVENT_NOTIFY, (ev) => {
      const d = (ev as CustomEvent<{ message?: string }>).detail;
      if (d?.message) this.notices.push(d.message);
    });
  }

  /** Lancement de l'app : deps.factory choisit la base d'après la session LOCALE. */
  async boot(): Promise<SyncedStorage> {
    this.manager = createDepsManager({
      createLocalStorage: () => new InMemoryStorage(),
      createClock: () => new FakeClock(),
      createIdGen: () => new SequentialIdGenerator(),
      createNotifier: () => new SpyNotifier(),
      createNoopDailyLogSync: () => ({ upsert: async () => undefined }),
      createDailyLogSync: () => ({ upsert: async () => undefined }),
      hasRemoteSync: true,
      getSessionUserId: () => this.session,
      openStorage: (owner) =>
        SyncedStorage.open({
          owner,
          remote:
            owner === 'guest'
              ? null
              : new SupabaseSyncRemote(this.client as never, owner, () => this.client.uid),
          factory: this.idb,
          autoSync: false,
          eventTarget: this.events,
          isOnline: () => this.navigatorOnline,
          now: () => this.clock.ms,
          loadMerge: async () => syncMerge,
          ...(this.tuning.pageSize ? { pageSize: this.tuning.pageSize } : {}),
          ...(this.tuning.batchMaxItems ? { batchMaxItems: this.tuning.batchMaxItems } : {}),
        }),
    });
    const deps = await this.manager.getDeps();
    expect(deps.storage).toBeInstanceOf(SyncedStorage);
    this.current = deps.storage as SyncedStorage;
    this.opened.push(this.current);
    return this.current;
  }

  /** Démarrage de la synchro tel que `SyncedStorage.start()` le fait (pull puis push). */
  async startup(): Promise<SyncedStorage> {
    const s = await this.boot();
    await s.sync({ ignoreBackoff: true });
    return s;
  }

  get storage(): SyncedStorage {
    if (!this.current) throw new Error(`${this.name} : app non lancée`);
    return this.current;
  }

  get owner(): string | null {
    return this.manager?.currentOwner() ?? null;
  }

  /** Fermeture forcée (iOS tue l'app) : rien n'est envoyé, la base est simplement fermée. */
  kill(): void {
    this.manager?.resetDeps();
    this.manager = null;
    this.current = null;
  }

  /** Connexion à un compte (session enregistrée + client partagé), puis base du compte. */
  async login(uid: string): Promise<SyncedStorage> {
    this.session = uid;
    this.client.uid = uid;
    return this.rebuild();
  }

  /** Déconnexion : envoi de ce qui attend, puis base invité. */
  async logout(): Promise<SyncedStorage> {
    await this.manager?.flushAndResetDeps();
    this.manager = null;
    this.session = null;
    this.client.uid = null;
    return this.boot();
  }

  /** Équivalent de `rebuildDepsForSession` (deps.ts) sur EVENT_AUTH_CHANGED. */
  private async rebuild(): Promise<SyncedStorage> {
    if (this.manager && this.manager.currentOwner() === this.manager.desiredOwner()) {
      return this.storage;
    }
    await this.manager?.flushAndResetDeps();
    this.manager = null;
    return this.boot();
  }

  offline(): void {
    this.net.up = false;
    this.navigatorOnline = false;
  }

  online(): void {
    this.net.up = true;
    this.navigatorOnline = true;
  }

  dump(db: string, store: string): Record<string, unknown> {
    return Object.fromEntries(
      [...this.fake.dump(db, store).entries()].map(([k, v]) => [String(k), v]),
    );
  }

  dispose(): void {
    for (const s of this.opened) s.dispose();
  }
}

/** Téléphone déjà connecté à `uid` (session persistée) et lancé. */
async function phoneOf(
  server: FakeSyncServer,
  name: string,
  uid: string,
  tuning?: { pageSize?: number; batchMaxItems?: number },
): Promise<Phone> {
  const p = new Phone(server, name, tuning);
  p.session = uid;
  p.client.uid = uid;
  await p.startup();
  return p;
}

// ─── Données métier ────────────────────────────────────────────────────────

function workout(id: string, name: string, reps = 5, day = 24): WorkoutSession {
  const at = `2026-11-${String(day).padStart(2, '0')}T08:00:00.000Z`;
  return {
    id,
    name,
    startedAt: at,
    endedAt: `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    entries: [
      {
        exerciseId: 'squat',
        sets: [{ setIndex: 0, reps, weightKg: 100, rpe: 8, performedAt: at }],
      },
    ],
  };
}

function template(id: string, name: string): WorkoutTemplate {
  return { id, name, createdAt: '2026-11-01T00:00:00.000Z', exercises: [] };
}

/** Séances vivantes côté serveur : id → nom. */
function cloudSessions(server: FakeSyncServer, uid: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.live(uid))) {
    if (k.startsWith(SESSION_PREFIX)) {
      const s = v as WorkoutSession;
      out[s.id] = s.name;
    }
  }
  return out;
}

/** Séances vues par l'app (loadSessions) : id → nom. */
async function appSessions(storage: StoragePort): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of await loadSessions(storage)) out[s.id] = s.name;
  return out;
}

/** Contenu local (kv) du compte sur un téléphone, hors clés propres à l'appareil. */
async function localSyncedKv(storage: SyncedStorage): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of await storage.keys()) {
    if (k === STORAGE_KEYS.TRAINING_ACTIVE_SESSION) continue;
    out[k] = await storage.get(k);
  }
  return out;
}

const pushCalls = (server: FakeSyncServer): number =>
  server.calls.filter((c) => c.name === 'sync_push').length;
const pullCalls = (server: FakeSyncServer): number =>
  server.calls.filter((c) => c.name === 'sync_pull_v2').length;

// ════════════════════════════════════════════════════════════════════════════

describe('1. Séance créée hors-ligne puis synchronisée', () => {
  it('séance enregistrée hors-ligne : visible tout de suite, envoyée au retour du réseau', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    phone.offline();

    await saveSession(phone.storage, workout('w1', 'Jambes'));
    expect(await appSessions(phone.storage)).toEqual({ w1: 'Jambes' });

    const before = server.calls.length;
    await phone.storage.sync();
    expect(server.calls.length).toBe(before); // navigator.onLine faux : aucun appel
    const st = await phone.storage.getStatus();
    expect(st).toMatchObject({ state: 'offline', pending: 1 });
    expect(cloudSessions(server, ALICE)).toEqual({});

    phone.online();
    await phone.storage.sync({ ignoreBackoff: true }); // événement `online`
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'Jambes' });
    expect(await phone.storage.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
    phone.dispose();
  });

  it('démarrage de l app HORS-LIGNE avec une session persistée : base du compte (pas invité), séance enregistrée puis synchronisée', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    await saveSession(phone.storage, workout('old', 'Ancienne'));
    await phone.storage.flushPendingWrites();
    phone.kill();

    phone.offline(); // avion ; le jeton a même expiré entre-temps
    server.expireSession(ALICE);
    const s = await phone.boot();
    expect(phone.owner).toBe(ALICE);
    expect(s.dbName).toBe('kinetic-u-user-alice');
    expect(await appSessions(s)).toEqual({ old: 'Ancienne' }); // données du compte, hors-ligne
    await saveSession(s, workout('w2', 'Dos'));
    await s.sync({ ignoreBackoff: true });
    phone.kill();

    phone.online();
    const again = await phone.startup(); // relance avec réseau : refresh du jeton puis envoi
    expect(cloudSessions(server, ALICE)).toEqual({ old: 'Ancienne', w2: 'Dos' });
    expect(await again.pendingCount()).toBe(0);
    phone.dispose();
  });
});

describe('2. Même séance modifiée sur deux appareils', () => {
  it('conflit : aucune perte, la version locale devient une copie « (conflit) » partout', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await saveSession(a.storage, workout('w1', 'Push', 5));
    await a.storage.flushPendingWrites();
    await b.storage.pull();

    a.offline();
    b.offline();
    await saveSession(a.storage, workout('w1', 'Push', 6)); // A : 6 reps
    b.clock.ms += 60_000;
    await saveSession(b.storage, workout('w1', 'Push lourd', 4)); // B : autre modif
    a.online();
    b.online();
    await a.storage.sync({ ignoreBackoff: true });
    await b.storage.sync({ ignoreBackoff: true });
    await a.storage.sync();

    const cloud = cloudSessions(server, ALICE);
    expect(Object.keys(cloud)).toHaveLength(2);
    expect(cloud['w1']).toBe('Push'); // première arrivée au serveur (A, 6 reps)
    const copyId = Object.keys(cloud).find((id) => id !== 'w1')!;
    expect(copyId).toMatch(/^w1-c\d+$/);
    expect(cloud[copyId]).toBe('Push lourd (conflit)');
    const copy = server.live(ALICE)[sessionStorageKey(copyId)] as WorkoutSession;
    expect(copy.entries[0]!.sets[0]!.reps).toBe(4); // contenu de B intact
    expect(
      (server.live(ALICE)[sessionStorageKey('w1')] as WorkoutSession).entries[0]!.sets[0]!.reps,
    ).toBe(6);

    // Les deux appareils voient les deux séances.
    expect(await appSessions(a.storage)).toEqual(cloud);
    expect(await appSessions(b.storage)).toEqual(cloud);
    expect(b.notices.some((n) => n.includes('deux appareils'))).toBe(true);
    // Pas de boucle : plus rien en attente, une nouvelle synchro ne change rien.
    expect(await a.storage.pendingCount()).toBe(0);
    expect(await b.storage.pendingCount()).toBe(0);
    const calls = pushCalls(server);
    await a.storage.sync();
    await b.storage.sync();
    expect(pushCalls(server)).toBe(calls);
    a.dispose();
    b.dispose();
  });
});

describe('3. Suppression hors-ligne puis synchro', () => {
  it('séance supprimée hors-ligne : disparaît localement, tombstone au retour du réseau, propagée', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await saveSession(a.storage, workout('w1', 'Bras'));
    await saveSession(a.storage, workout('w2', 'Cardio'));
    await a.storage.flushPendingWrites();
    await b.storage.pull();

    a.offline();
    await deleteSession(a.storage, 'w1');
    expect(await appSessions(a.storage)).toEqual({ w2: 'Cardio' });
    a.kill(); // l'app est même fermée avant le retour du réseau
    a.online();
    await a.startup();
    expect(server.row(ALICE, sessionStorageKey('w1'))).toMatchObject({ deleted: true });
    await b.storage.sync();
    expect(await appSessions(b.storage)).toEqual({ w2: 'Cardio' });
    a.dispose();
    b.dispose();
  });
});

describe('4. Suppression propagée à plusieurs appareils', () => {
  it('A supprime : B et C ne la voient plus, et elle ne réapparaît pas après d autres synchros', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    const c = await phoneOf(server, 'C', ALICE);
    await saveSession(a.storage, workout('w1', 'Full body'));
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    await c.storage.sync();
    expect(await appSessions(c.storage)).toEqual({ w1: 'Full body' });

    await deleteSession(a.storage, 'w1');
    await a.storage.sync();
    await b.storage.sync();
    await c.storage.sync();
    expect(await appSessions(b.storage)).toEqual({});
    expect(await appSessions(c.storage)).toEqual({});

    // D'autres écritures et plusieurs tours de synchro : aucune résurrection.
    await saveSession(b.storage, workout('w2', 'Mobilité'));
    await saveSession(c.storage, workout('w3', 'Course'));
    for (let round = 0; round < 3; round++) {
      for (const p of [a, b, c]) await p.storage.sync();
    }
    expect(cloudSessions(server, ALICE)).toEqual({ w2: 'Mobilité', w3: 'Course' });
    for (const p of [a, b, c]) {
      expect(await appSessions(p.storage)).toEqual({ w2: 'Mobilité', w3: 'Course' });
      expect(await p.storage.pendingCount()).toBe(0);
    }
    // Un appareil qui relance l'app (cache vidé, nouveau pull complet) ne la revoit pas.
    c.kill();
    await c.startup();
    await c.storage.clearDevice();
    await c.storage.sync();
    expect(await appSessions(c.storage)).toEqual({ w2: 'Mobilité', w3: 'Course' });
    for (const p of [a, b, c]) p.dispose();
  });

  it('règle documentée : B avait MODIFIÉ la séance hors-ligne → sa version est recréée (une séance n est jamais perdue)', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    const c = await phoneOf(server, 'C', ALICE);
    await saveSession(a.storage, workout('w1', 'Push', 5));
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    await c.storage.sync();

    b.offline();
    await saveSession(b.storage, workout('w1', 'Push', 8)); // série ajoutée hors-ligne
    await deleteSession(a.storage, 'w1');
    await a.storage.sync();
    await c.storage.sync();
    expect(await appSessions(c.storage)).toEqual({});

    b.online();
    await b.storage.sync({ ignoreBackoff: true });
    const recreated = server.live(ALICE)[sessionStorageKey('w1')] as WorkoutSession;
    expect(recreated.entries[0]!.sets[0]!.reps).toBe(8);
    for (const p of [a, c]) await p.storage.sync();
    for (const p of [a, b, c]) expect(await appSessions(p.storage)).toEqual({ w1: 'Push' });
    for (const p of [a, b, c]) p.dispose();
  });

  it('B avait une entrée en attente SANS changement réel de la séance : la suppression gagne', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await saveSession(a.storage, workout('w1', 'Push'));
    await a.storage.flushPendingWrites();
    await b.storage.sync();

    b.offline();
    // L'app réenregistre la séance à l'identique (écran ouvert puis fermé) : aucune entrée.
    await saveSession(b.storage, workout('w1', 'Push'));
    expect(await b.storage.pendingCount()).toBe(0);
    await deleteSession(a.storage, 'w1');
    await a.storage.sync();
    b.online();
    await b.storage.sync({ ignoreBackoff: true });
    expect(await appSessions(b.storage)).toEqual({});
    expect(server.row(ALICE, sessionStorageKey('w1'))!.deleted).toBe(true);
    a.dispose();
    b.dispose();
  });
});

describe('5. Coupure réseau pendant une écriture (lot partiellement envoyé)', () => {
  it('250 séances, le réseau tombe après le 1er lot : rien de perdu, aucun doublon, reprise', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    for (let i = 0; i < 250; i++) await saveSession(phone.storage, workout(`w${i}`, `S${i}`));
    phone.net.cutAfter = 1; // 1er lot validé, puis plus de réseau
    await phone.storage.flushPendingWrites();
    expect(Object.keys(cloudSessions(server, ALICE))).toHaveLength(100);
    expect(await phone.storage.pendingCount()).toBe(150);
    expect((await phone.storage.getStatus()).state).toBe('error');

    phone.net.up = true;
    // Le 2e lot est validé par le serveur mais la réponse est perdue (tunnel, 4G).
    server.dropResponseOnce('sync_push');
    await phone.storage.flushPendingWrites({ ignoreBackoff: true });
    // Le 2e lot est sur le serveur ; l'envoi s'arrête à la réponse perdue (backoff).
    expect(Object.keys(cloudSessions(server, ALICE))).toHaveLength(200);
    expect(await phone.storage.pendingCount()).toBe(150); // lot « perdu » + 3e lot
    const versions = new Map(
      Object.keys(server.live(ALICE)).map((k) => [k, server.row(ALICE, k)!.updated_at]),
    );

    await phone.storage.flushPendingWrites({ ignoreBackoff: true });
    expect(await phone.storage.pendingCount()).toBe(0);
    // Renvoi idempotent du lot perdu : mêmes versions, pas de conflit, pas de copie.
    for (const [k, v] of versions) expect(server.row(ALICE, k)!.updated_at).toBe(v);
    expect(Object.keys(cloudSessions(server, ALICE))).toHaveLength(250);
    expect(await phone.storage.listRecovery()).toEqual([]);
    expect(await localSyncedKv(phone.storage)).toEqual(server.live(ALICE));
    phone.dispose();
  });

  it('écriture locale pendant un envoi coupé : la nouvelle valeur part ensuite, l ancienne n écrase rien', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    await saveSession(phone.storage, workout('w1', 'Push', 5));
    phone.net.cutAfter = 1;
    server.dropResponseOnce('sync_push'); // le serveur reçoit 5 reps, la réponse se perd
    await phone.storage.flushPendingWrites();
    await saveSession(phone.storage, workout('w1', 'Push', 7)); // l'utilisateur corrige
    phone.net.up = true;
    await phone.storage.flushPendingWrites({ ignoreBackoff: true });
    await phone.storage.flushPendingWrites({ ignoreBackoff: true });
    expect(
      (server.live(ALICE)[sessionStorageKey('w1')] as WorkoutSession).entries[0]!.sets[0]!.reps,
    ).toBe(7);
    expect(Object.keys(cloudSessions(server, ALICE))).toEqual(['w1']); // pas de copie parasite
    expect(await phone.storage.pendingCount()).toBe(0);
    phone.dispose();
  });
});

describe('6. Coupure réseau pendant une lecture (pull interrompu)', () => {
  it('premier pull complet interrompu : reprise depuis zéro, aucune clé manquante ni curseur prématuré', async () => {
    const server = new FakeSyncServer();
    for (let i = 0; i < 1200; i++)
      server.seed(ALICE, sessionStorageKey(`w${i}`), workout(`w${i}`, `S${i}`));
    const phone = new Phone(server, 'nouvel iPhone');
    phone.session = ALICE;
    phone.client.uid = ALICE;
    const s = await phone.boot();
    phone.net.cutOn = 'sync_pull_v2';
    phone.net.cutAfter = 1; // 1re page reçue, puis tunnel
    await s.pull();
    expect((await s.keys()).length).toBe(500); // 1re page appliquée (transaction unique)
    const meta = phone.dump('kinetic-u-user-alice', 'meta');
    expect(meta['cursor']).toBeUndefined(); // passe complète : curseur seulement à la fin
    expect(meta['initialPullDone']).toBeUndefined();
    expect((await s.getStatus()).lastPullAt).toBeNull();

    phone.net.up = true;
    await s.pull();
    expect((await s.keys()).length).toBe(1200);
    expect(await localSyncedKv(s)).toEqual(server.live(ALICE));
    expect(await s.isInitialPullDone()).toBe(true);
    phone.dispose();
  });

  it('pull delta interrompu : le curseur reflète exactement les pages appliquées, reprise sans trou', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, STORAGE_KEYS.XP, 10); // compte déjà utilisé : B a un curseur delta
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE, { pageSize: 50 });
    expect(b.dump('kinetic-u-user-alice', 'meta')['cursor']).toBeDefined();
    for (let i = 0; i < 120; i++) await saveSession(a.storage, workout(`w${i}`, `S${i}`));
    await a.storage.flushPendingWrites();
    await deleteSession(a.storage, 'w3');
    await a.storage.flushPendingWrites();

    b.net.cutOn = 'sync_pull_v2';
    b.net.cutAfter = 2; // 2 pages de 50 reçues
    await b.storage.pull();
    expect((await b.storage.keys()).length).toBe(101);
    const cursor = b.dump('kinetic-u-user-alice', 'meta')['cursor'] as {
      since: string;
      afterKey: string;
    };
    // Curseur = dernière ligne de la 2e page (écrit dans la même transaction que la page).
    const rows = Object.keys(server.live(ALICE))
      .filter((k) => k !== STORAGE_KEYS.XP)
      .concat([sessionStorageKey('w3')])
      .map((k) => ({ k, v: server.row(ALICE, k)!.updated_at }))
      .sort((x, y) => (x.v === y.v ? (x.k < y.k ? -1 : 1) : x.v < y.v ? -1 : 1));
    expect(cursor.since).toBe(rows[99]!.v);
    expect(cursor.afterKey).toBe(rows[99]!.k);

    // Entre-temps, A écrit encore (y compris une clé déjà reçue par B).
    await saveSession(a.storage, workout('w0', 'S0 modifiée'));
    await saveSession(a.storage, workout('late', 'Tardive'));
    await a.storage.flushPendingWrites();
    b.net.up = true;
    await b.storage.pull();
    expect(await appSessions(b.storage)).toEqual(cloudSessions(server, ALICE));
    expect(await localSyncedKv(b.storage)).toEqual(server.live(ALICE));
    a.dispose();
    b.dispose();
  });
});

describe('7. Redémarrage avec une outbox non vide (persistance atomique)', () => {
  it('fermeture forcée juste après des écritures : outbox intacte au redémarrage, tout est envoyé', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    phone.offline();
    await saveSession(phone.storage, workout('w1', 'A'));
    await saveSession(phone.storage, workout('w2', 'B'));
    await deleteSession(phone.storage, 'w2');
    await saveTemplates(phone.storage, [template('t1', 'Mon modèle')]);
    phone.kill();

    const outbox = phone.dump('kinetic-u-user-alice', 'outbox');
    expect(Object.keys(outbox).sort()).toEqual(
      [sessionStorageKey('w1'), sessionStorageKey('w2'), STORAGE_KEYS.TRAINING_TEMPLATES].sort(),
    );
    expect(outbox[sessionStorageKey('w2')]).toMatchObject({ op: 'delete', base: null });
    phone.online();
    const s = await phone.startup();
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'A' });
    expect(server.live(ALICE)[sessionStorageKey('w2')]).toBeUndefined();
    expect(server.live(ALICE)[STORAGE_KEYS.TRAINING_TEMPLATES]).toEqual([
      template('t1', 'Mon modèle'),
    ]);
    expect(await s.pendingCount()).toBe(0);
    phone.dispose();
  });

  it('écriture refusée par IndexedDB (stockage plein) : erreur remontée à l app, ni donnée ni outbox fantôme', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    phone.fake.failNext((op) => op.store === 'outbox' && op.kind === 'put', 'QuotaExceededError');
    await expect(saveSession(phone.storage, workout('w1', 'A'))).rejects.toThrow();
    phone.kill();
    const s = await phone.startup();
    expect(await appSessions(s)).toEqual({});
    expect(await s.pendingCount()).toBe(0);
    expect(server.live(ALICE)).toEqual({});
    phone.dispose();
  });

  it('app tuée pendant l envoi (réponse jamais reçue) : renvoi au redémarrage sans doublon', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    await saveSession(phone.storage, workout('w1', 'A'));
    server.dropResponseOnce('sync_push');
    await phone.storage.flushPendingWrites();
    phone.kill();
    const s = await phone.startup();
    expect(await s.pendingCount()).toBe(0);
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'A' });
    expect(await s.listRecovery()).toEqual([]);
    phone.dispose();
  });
});

describe('8. Synchro interrompue puis reprise (pagination, curseur)', () => {
  it('écritures d un autre appareil ENTRE les pages et coupures répétées : ni doublon ni trou', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, STORAGE_KEYS.XP, 1);
    const b = await phoneOf(server, 'B', ALICE, { pageSize: 7 });
    // B a un curseur ; 40 changements arrivent pendant que B dort.
    for (let i = 0; i < 40; i++) server.seed(ALICE, `kinetic:n:${String(i).padStart(3, '0')}`, i);
    let injected = 0;
    // Après chaque page reçue, un autre appareil écrit : clé nouvelle, clé déjà reçue
    // (re-modifiée), clé supprimée.
    b.net.afterCall = (name) => {
      if (name !== 'sync_pull_v2' || injected >= 12) return;
      injected++;
      server.seed(ALICE, `kinetic:n:new${injected}`, injected);
      server.seed(ALICE, 'kinetic:n:000', 1000 + injected);
      if (injected === 3) {
        // DELETE d'un ancien client → tombstone (trigger 010).
        server.clientDelete(ALICE, 'kinetic:n:005');
      }
    };
    const seen = { pulls: 0 };
    // Coupure toutes les 2 pages, plusieurs fois.
    for (let attempt = 0; attempt < 30; attempt++) {
      b.net.up = true;
      b.net.cutOn = 'sync_pull_v2';
      b.net.cutAfter = 2;
      await b.storage.pull();
      seen.pulls++;
      if (b.net.up) break; // pull terminé sans coupure
    }
    b.net.up = true;
    b.net.cutAfter = null;
    b.net.afterCall = null;
    await b.storage.pull();
    expect(await localSyncedKv(b.storage)).toEqual(server.live(ALICE));
    expect(await b.storage.get('kinetic:n:005')).toBeNull();
    expect(await b.storage.get('kinetic:n:000')).toBe(1000 + injected);
    expect(seen.pulls).toBeGreaterThan(3);
    expect(injected).toBeGreaterThanOrEqual(3);
    b.dispose();
  });
});

describe('9. Conflits simultanés sur clés agrégées', () => {
  it('pesées ajoutées sur deux appareils hors-ligne : union par date, rien de perdu', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    const KEY = STORAGE_KEYS.BODYWEIGHT_ENTRIES;
    await a.storage.set(KEY, [{ date: '2026-11-20', kg: 80 }]);
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    a.offline();
    b.offline();
    const fromA = (await a.storage.get<Array<{ date: string; kg: number }>>(KEY)) ?? [];
    await a.storage.set(KEY, [...fromA, { date: '2026-11-22', kg: 79.5 }]);
    const fromB = (await b.storage.get<Array<{ date: string; kg: number }>>(KEY)) ?? [];
    await b.storage.set(KEY, [...fromB, { date: '2026-11-21', kg: 79.8 }]);
    a.online();
    b.online();
    await a.storage.sync({ ignoreBackoff: true });
    await b.storage.sync({ ignoreBackoff: true });
    await a.storage.sync();
    const expected = [
      { date: '2026-11-20', kg: 80 },
      { date: '2026-11-21', kg: 79.8 },
      { date: '2026-11-22', kg: 79.5 },
    ];
    expect(server.live(ALICE)[KEY]).toEqual(expected);
    expect(await a.storage.get(KEY)).toEqual(expected);
    expect(await b.storage.get(KEY)).toEqual(expected);
    a.dispose();
    b.dispose();
  });

  it('modèles : A en supprime un (saveTemplates), B en ajoute et en modifie un autre → fusion, la suppression tient', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await saveTemplates(a.storage, [template('t1', 'Haut'), template('t2', 'Bas')]);
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    a.offline();
    b.offline();
    // A : supprime t1 via le chemin réel de l'app (liste réécrite sans l'élément).
    const listA = await loadTemplates(a.storage);
    await saveTemplates(
      a.storage,
      listA.filter((t) => t.id !== 't1'),
    );
    // B : renomme t2, ajoute t3.
    const listB = await loadTemplates(b.storage);
    await saveTemplates(b.storage, [
      ...listB.map((t) => (t.id === 't2' ? { ...t, name: 'Bas (B)' } : t)),
      template('t3', 'Gainage'),
    ]);
    a.online();
    b.online();
    await a.storage.sync({ ignoreBackoff: true });
    await b.storage.sync({ ignoreBackoff: true });
    await a.storage.sync();
    const byId = (list: unknown): Record<string, string> =>
      Object.fromEntries((list as WorkoutTemplate[]).map((t) => [t.id, t.name]));
    const expected = { t2: 'Bas (B)', t3: 'Gainage' };
    expect(byId(server.live(ALICE)[STORAGE_KEYS.TRAINING_TEMPLATES])).toEqual(expected);
    expect(byId(await loadTemplates(a.storage))).toEqual(expected);
    expect(byId(await loadTemplates(b.storage))).toEqual(expected);
    a.dispose();
    b.dispose();
  });

  it('suppression d élément avec marque (deleteCollectionItems + setMany) : respectée face à une liste périmée réécrite sur un appareil effacé (base nulle)', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    const KEY = STORAGE_KEYS.TRAINING_TEMPLATES;
    await saveTemplates(a.storage, [template('t1', 'Haut'), template('t2', 'Bas')]);
    await a.storage.flushPendingWrites();
    await b.storage.sync();

    a.offline();
    const items = await loadTemplates(a.storage);
    const del = deleteCollectionItems(
      KEY,
      items,
      ['t1'],
      await a.storage.get(STORAGE_KEYS.ITEM_TOMBSTONES(KEY)),
      new Date(a.clock.ms).toISOString(),
    );
    await a.storage.setMany(del.writes); // liste + marque : une seule transaction
    // B : données de l appareil effacées, puis la liste d AVANT la suppression réécrite
    // (base nulle : B ne connaît pas la collection du serveur), plus un ajout t4.
    await b.storage.clearDevice();
    await saveTemplates(b.storage, [
      template('t1', 'Haut'),
      template('t2', 'Bas'),
      template('t4', 'Bras'),
    ]);
    a.online();
    await a.storage.sync({ ignoreBackoff: true });
    await b.storage.sync({ ignoreBackoff: true });
    await a.storage.sync();
    const ids = (await loadTemplates(a.storage)).map((t) => t.id).sort();
    expect(ids).toEqual(['t2', 't4']);
    expect(((server.live(ALICE)[KEY] as WorkoutTemplate[]) ?? []).map((t) => t.id).sort()).toEqual([
      't2',
      't4',
    ]);
    expect((await loadTemplates(b.storage)).map((t) => t.id).sort()).toEqual(['t2', 't4']);
    a.dispose();
    b.dispose();
  });

  it('XP gagnée sur deux appareils hors-ligne : les gains s additionnent', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await a.storage.set(STORAGE_KEYS.XP, 100);
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    a.offline();
    b.offline();
    await a.storage.set(STORAGE_KEYS.XP, 130); // +30
    await b.storage.set(STORAGE_KEYS.XP, 150); // +50
    a.online();
    b.online();
    await a.storage.sync({ ignoreBackoff: true });
    await b.storage.sync({ ignoreBackoff: true });
    await a.storage.sync();
    expect(server.live(ALICE)[STORAGE_KEYS.XP]).toBe(180);
    expect(await a.storage.get(STORAGE_KEYS.XP)).toBe(180);
    expect(await b.storage.get(STORAGE_KEYS.XP)).toBe(180);
    a.dispose();
    b.dispose();
  });
});

describe('10. Changement de compte sur un appareil (A → B → A)', () => {
  it('isolation totale : rien n est poussé dans le mauvais compte, chacun retrouve ses données', async () => {
    const server = new FakeSyncServer();
    server.seed(BOB, sessionStorageKey('bob1'), workout('bob1', 'Séance de Bob'));
    const phone = await phoneOf(server, 'iPad partagé', ALICE);
    await saveSession(phone.storage, workout('al1', 'Séance d Alice'));
    await phone.storage.flushPendingWrites();
    // Alice enregistre une séance hors-ligne, puis se déconnecte sans réseau.
    phone.offline();
    await saveSession(phone.storage, workout('al2', 'Alice hors-ligne'));
    const guest = await phone.logout();
    expect(guest.owner).toBe('guest');
    expect(await appSessions(guest)).toEqual({});

    // Bob se connecte (réseau revenu) : il ne voit que ses données.
    phone.online();
    const bob = await phone.login(BOB);
    expect(bob.dbName).toBe('kinetic-u-user-bob');
    await bob.sync({ ignoreBackoff: true });
    expect(await appSessions(bob)).toEqual({ bob1: 'Séance de Bob' });
    await saveSession(bob, workout('bob2', 'Bob encore'));
    await bob.flushPendingWrites();
    expect(cloudSessions(server, BOB)).toEqual({ bob1: 'Séance de Bob', bob2: 'Bob encore' });
    expect(cloudSessions(server, ALICE)).toEqual({ al1: 'Séance d Alice' });

    // Alice revient : sa séance hors-ligne part dans SON compte.
    await phone.logout();
    const alice = await phone.login(ALICE);
    await alice.sync({ ignoreBackoff: true });
    expect(await appSessions(alice)).toEqual({
      al1: 'Séance d Alice',
      al2: 'Alice hors-ligne',
    });
    expect(cloudSessions(server, ALICE)).toEqual({
      al1: 'Séance d Alice',
      al2: 'Alice hors-ligne',
    });
    expect(cloudSessions(server, BOB)).toEqual({ bob1: 'Séance de Bob', bob2: 'Bob encore' });
    phone.dispose();
  });

  it('base d Alice encore ouverte quand la session du client passe à Bob : elle n envoie RIEN', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    const aliceDb = phone.storage;
    await saveSession(aliceDb, workout('al1', 'Alice'));
    phone.client.uid = BOB; // connexion de Bob dans un autre onglet (client partagé)
    await aliceDb.flushPendingWrites();
    expect(server.live(BOB)).toEqual({});
    expect(server.live(ALICE)).toEqual({});
    expect((await aliceDb.getStatus()).state).toBe('auth_required');
    expect(await aliceDb.pendingCount()).toBe(1);
    phone.dispose();
  });
});

describe('Réinstallation / nouvel appareil', () => {
  it('nouvel appareil : les modèles par défaut ne sont jamais écrits par-dessus ceux du cloud', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, STORAGE_KEYS.TRAINING_TEMPLATES, [template('mine', 'Mon programme')]);
    server.seed(ALICE, sessionStorageKey('w1'), workout('w1', 'Historique'));
    const phone = new Phone(server, 'nouvel iPhone');
    phone.session = ALICE;
    phone.client.uid = ALICE;
    const s = await phone.boot();
    // L'accueil se rend AVANT la synchro : défauts en mémoire, rien d'écrit.
    const defaults = await loadTemplates(s);
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.some((t) => t.id === 'mine')).toBe(false);
    expect(await s.pendingCount()).toBe(0);
    await s.sync({ ignoreBackoff: true });
    expect((await loadTemplates(s)).map((t) => t.id)).toEqual(['mine']);
    expect(await appSessions(s)).toEqual({ w1: 'Historique' });
    expect(server.live(ALICE)[STORAGE_KEYS.TRAINING_TEMPLATES]).toEqual([
      template('mine', 'Mon programme'),
    ]);
    phone.dispose();
  });

  it('nouvel appareil hors-ligne : l utilisateur modifie les modèles avant le 1er pull → fusion, le cloud n est pas écrasé', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, STORAGE_KEYS.TRAINING_TEMPLATES, [template('mine', 'Mon programme')]);
    const phone = new Phone(server, 'nouvel iPhone');
    phone.session = ALICE;
    phone.client.uid = ALICE;
    phone.offline();
    const s = await phone.boot();
    const list = await loadTemplates(s); // défauts en mémoire
    await saveTemplates(s, [...list, template('new', 'Créé hors-ligne')]);
    phone.online();
    await s.sync({ ignoreBackoff: true });
    const ids = (
      (server.live(ALICE)[STORAGE_KEYS.TRAINING_TEMPLATES] as WorkoutTemplate[]) ?? []
    ).map((t) => t.id);
    expect(ids).toContain('mine');
    expect(ids).toContain('new');
    phone.dispose();
  });
});

describe('Liaison invité → compte', () => {
  it('séances faites en invité puis connexion : proposées, ajoutées sur demande, sans écraser le compte', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, sessionStorageKey('cloud1'), workout('cloud1', 'Du cloud'));
    server.seed(ALICE, STORAGE_KEYS.XP, 200);
    const phone = new Phone(server, 'iPhone');
    const guest = await phone.boot();
    expect(guest.owner).toBe('guest');
    await saveSession(guest, workout('g1', 'Invité'));
    await guest.set(STORAGE_KEYS.XP, 40);
    await guest.sync();
    expect(server.calls).toHaveLength(0); // invité : jamais de réseau

    const alice = await phone.login(ALICE);
    await alice.sync({ ignoreBackoff: true });
    expect(await appSessions(alice)).toEqual({ cloud1: 'Du cloud' }); // rien d'automatique
    expect((await alice.guestDataSummary()).count).toBe(2);
    await alice.importGuestData();
    await alice.flushPendingWrites();
    expect(cloudSessions(server, ALICE)).toEqual({ cloud1: 'Du cloud', g1: 'Invité' });
    expect(server.live(ALICE)[STORAGE_KEYS.XP]).toBe(240); // XP : somme
    expect((await alice.guestDataSummary()).decision).toBe('linked');
    // Base invité conservée intacte.
    expect(phone.dump('kinetic-guest', 'kv')[sessionStorageKey('g1')]).toBeDefined();
    phone.dispose();
  });
});

describe('Rejet permanent (dead-letter)', () => {
  it('quota atteint : entrée bloquée visible, aucune boucle, donnée locale gardée, « Réessayer » après libération', async () => {
    const server = new FakeSyncServer({ maxKeys: 2 });
    const phone = await phoneOf(server, 'iPhone', ALICE);
    await saveSession(phone.storage, workout('w1', 'A'));
    await saveSession(phone.storage, workout('w2', 'B'));
    await phone.storage.flushPendingWrites();
    await saveSession(phone.storage, workout('w3', 'C'));
    await phone.storage.flushPendingWrites();
    const st = await phone.storage.getStatus();
    expect(st.blocked).toEqual([{ key: sessionStorageKey('w3'), reason: 'quota_keys' }]);
    expect(st.state).toBe('error');
    const calls = pushCalls(server);
    for (let i = 0; i < 5; i++) {
      phone.clock.ms += 10 * 60_000;
      await phone.storage.sync({ ignoreBackoff: true });
    }
    expect(pushCalls(server)).toBe(calls); // pas de réessai automatique
    expect(await appSessions(phone.storage)).toEqual({ w1: 'A', w2: 'B', w3: 'C' });

    server.maxKeys = 10; // offre supérieure / ménage côté serveur
    await phone.storage.retryBlocked();
    await phone.storage.flushPendingWrites();
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'A', w2: 'B', w3: 'C' });
    expect((await phone.storage.getStatus()).blocked).toEqual([]);
    phone.dispose();
  });
});

describe('« Supprimer toutes mes données cloud » avec échec réseau', () => {
  it('pas de faux succès ; la demande survit au redémarrage, part en premier, et B est vidé', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B', ALICE);
    await saveSession(a.storage, workout('w1', 'A'));
    await saveSession(a.storage, workout('w2', 'B'));
    await a.storage.flushPendingWrites();
    await b.storage.sync();

    a.net.up = false; // réseau qui ne répond pas (navigator.onLine encore vrai)
    await expect(a.storage.deleteAllCloudData()).rejects.toThrow();
    expect((await a.storage.getStatus()).deleteAllPending).toBe(true);
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'A', w2: 'B' });
    // Les données locales ne sont PAS effacées tant que le serveur n'a pas confirmé.
    expect(await appSessions(a.storage)).toEqual({ w1: 'A', w2: 'B' });
    a.kill();

    a.net.up = true;
    const s = await a.startup();
    expect((await s.getStatus()).deleteAllPending).toBe(false);
    expect(cloudSessions(server, ALICE)).toEqual({});
    expect(await appSessions(s)).toEqual({});
    await b.storage.sync();
    expect(await appSessions(b.storage)).toEqual({});
    a.dispose();
    b.dispose();
  });
});

describe('resync_required après purge des tombstones', () => {
  it('appareil resté hors-ligne 200 jours : rien n est supprimé en silence, tout est récupérable', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOf(server, 'A', ALICE);
    const b = await phoneOf(server, 'B (tiroir)', ALICE);
    await saveSession(a.storage, workout('w1', 'Supprimée ailleurs'));
    await saveSession(a.storage, workout('w2', 'Gardée'));
    await a.storage.flushPendingWrites();
    await b.storage.sync();
    b.offline();
    await saveSession(b.storage, workout('w9', 'Faite hors-ligne'));

    await deleteSession(a.storage, 'w1');
    await a.storage.sync();
    server.advance(200 * 24 * 3600 * 1000);
    expect(server.purge(180 * 24 * 3600 * 1000)).toBe(1);

    b.online();
    b.clock.ms += 200 * 24 * 3600 * 1000;
    await b.storage.sync({ ignoreBackoff: true });
    expect(await appSessions(b.storage)).toEqual({ w2: 'Gardée', w9: 'Faite hors-ligne' });
    expect(cloudSessions(server, ALICE)).toEqual({ w2: 'Gardée', w9: 'Faite hors-ligne' });
    const rec = await b.storage.listRecovery();
    expect(rec).toEqual([
      expect.objectContaining({ key: sessionStorageKey('w1'), reason: 'resync' }),
    ]);
    expect(b.notices.length).toBeGreaterThan(0);
    // « Restaurer » : la séance revient partout.
    await b.storage.restoreRecovery(rec[0]!.id);
    await b.storage.flushPendingWrites();
    await a.storage.sync();
    expect(await appSessions(a.storage)).toEqual({
      w1: 'Supprimée ailleurs',
      w2: 'Gardée',
      w9: 'Faite hors-ligne',
    });
    a.dispose();
    b.dispose();
  });
});

describe('Migration de l ancienne base IndexedDB et de l ancienne outbox', () => {
  it('données écrites par l ANCIEN client (HybridStorage) hors-ligne : aucune perte après mise à jour', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, sessionStorageKey('cloud1'), workout('cloud1', 'Autre appareil'));
    // ── Ancienne version de l'app, réelle : HybridStorage + SupabaseStorage ──
    const oldLocal = new InMemoryStorage();
    const oldClient = server.client(ALICE);
    const old = new HybridStorage(oldLocal, new SupabaseStorage(oldClient as never, ALICE), {
      scheduleRetry: null,
    });
    await old.ready;
    await saveSession(old, workout('synced', 'Déjà envoyée'));
    await old.flushPendingWrites();
    server.networkDown = true;
    await saveSession(old, workout('offline', 'Pas encore envoyée'));
    await deleteSession(old, 'synced');
    await old.set(STORAGE_KEYS.TRAINING_ACTIVE_SESSION, { v: 0 });
    await old.flushPendingWrites();
    old.dispose();
    server.networkDown = false;
    expect(oldLocal.has(STORAGE_KEYS.SYNC_OUTBOX)).toBe(true);

    // ── L'ancienne base (`keyval-store` / `keyval`) telle qu'elle est sur l'appareil ──
    const phone = new Phone(server, 'iPhone');
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = phone.idb.open('keyval-store');
      req.onupgradeneeded = () => req.result.createObjectStore('keyval');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(['keyval'], 'readwrite');
      for (const [k, v] of Object.entries(oldLocal.snapshot())) tx.objectStore('keyval').put(v, k);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    legacy.close();

    // ── Mise à jour de l'app, démarrage hors-ligne avec la session persistée ──
    phone.session = ALICE;
    phone.client.uid = ALICE;
    phone.offline();
    const s = await phone.boot();
    expect(s.migration).toMatchObject({ status: 'migrated' });
    expect(await appSessions(s)).toEqual({ offline: 'Pas encore envoyée' });
    expect(await s.get(STORAGE_KEYS.TRAINING_ACTIVE_SESSION)).toEqual({ v: 0 });
    phone.kill();

    phone.online();
    const again = await phone.startup();
    // Règle documentée (sync.md § 4.8 bis) : une suppression de séance venue de l'ANCIENNE
    // outbox n'a pas d'ancêtre connu (l'ancien client ne notait aucune version) ; elle ne
    // peut pas être distinguée d'une suppression faite avant une modification ailleurs.
    // Une séance n'étant jamais perdue, la suppression est annulée AVEC un message.
    expect(cloudSessions(server, ALICE)).toEqual({
      cloud1: 'Autre appareil',
      offline: 'Pas encore envoyée',
      synced: 'Déjà envoyée',
    });
    expect(phone.notices.some((n) => n.includes('Déjà envoyée'))).toBe(true);
    expect(await appSessions(again)).toEqual(cloudSessions(server, ALICE));
    expect(server.live(ALICE)[STORAGE_KEYS.TRAINING_ACTIVE_SESSION]).toBeUndefined();
    expect(await again.pendingCount()).toBe(0);
    // Ancienne base conservée (retour arrière possible), marquée.
    expect(phone.dump('keyval-store', 'keyval')[STORAGE_KEYS.SYNC_MIGRATED_TO]).toBe(
      'kinetic-u-user-alice',
    );
    phone.dispose();
  });
});

describe('Mobile', () => {
  it('fermeture forcée pendant une séance : la séance en cours est reprise au redémarrage, jamais envoyée', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    const live = { ...workout('cur', 'En cours'), endedAt: undefined };
    const snap = snapshotActiveSession(
      {
        session: live,
        restEndsAtMs: phone.clock.ms + 60_000,
        restTotalSec: 90,
        restPresetSec: 90,
        activeExerciseId: 'squat',
      },
      phone.clock.ms,
    );
    await writeActiveSession(phone.storage, snap);
    phone.kill(); // iOS tue l'app pendant le repos

    const s = await phone.startup();
    const restored = await loadActiveSession(s);
    expect(restored?.session.id).toBe('cur');
    expect(restored?.activeExerciseId).toBe('squat');
    expect(server.live(ALICE)[STORAGE_KEYS.TRAINING_ACTIVE_SESSION]).toBeUndefined();
    // Fin de séance : enregistrée et envoyée, l'instantané effacé.
    await saveSession(s, workout('cur', 'En cours'));
    await writeActiveSession(s, null);
    await s.flushPendingWrites();
    expect(cloudSessions(server, ALICE)).toEqual({ cur: 'En cours' });
    expect(await loadActiveSession(s)).toBeNull();
    phone.dispose();
  });

  it('redémarrage après une séance non synchronisée : envoyée automatiquement par start() au retour du réseau', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    phone.offline();
    await saveSession(phone.storage, workout('w1', 'Salle sans réseau'));
    await phone.storage.flushPendingWrites(); // échoue hors-ligne
    phone.kill();
    phone.online();
    const s = await phone.boot();
    s.start(); // chemin réel : onStorageReady → start() → sync({ ignoreBackoff: true })
    for (let i = 0; i < 100 && (await s.pendingCount()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'Salle sans réseau' });
    phone.dispose();
  });

  it('reprise après perte de réseau : backoff pendant la coupure, envoi dès le retour', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    phone.net.up = false; // 4G « connectée » mais rien ne passe
    await saveSession(phone.storage, workout('w1', 'A'));
    await phone.storage.flushPendingWrites();
    const calls = pushCalls(server);
    await phone.storage.flushPendingWrites(); // backoff non écoulé : pas d'appel inutile
    expect(pushCalls(server)).toBe(calls);
    expect((await phone.storage.getStatus()).pending).toBe(1);
    phone.clock.ms += 30_000;
    await saveSession(phone.storage, workout('w2', 'B'));
    phone.net.up = true;
    await phone.storage.sync({ ignoreBackoff: true }); // `online` / retour au premier plan
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'A', w2: 'B' });
    expect(await phone.storage.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
    phone.dispose();
  });

  it('restauration après reconnexion : données de l appareil effacées puis restaurées depuis le cloud', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, 'iPhone', ALICE);
    for (let i = 0; i < 5; i++) await saveSession(phone.storage, workout(`w${i}`, `S${i}`));
    await phone.storage.flushPendingWrites();
    await phone.storage.clearDevice();
    expect(await appSessions(phone.storage)).toEqual({});
    phone.offline();
    await saveSession(phone.storage, workout('new', 'Après effacement'));
    phone.kill();
    phone.online();
    const s = await phone.boot();
    await s.syncFromRemote({ force: true }); // Profil › « Restaurer depuis le cloud »
    expect(Object.keys(await appSessions(s)).sort()).toEqual(
      ['new', 'w0', 'w1', 'w2', 'w3', 'w4'].sort(),
    );
    expect(Object.keys(cloudSessions(server, ALICE))).toHaveLength(6);
    phone.dispose();
  });
});
