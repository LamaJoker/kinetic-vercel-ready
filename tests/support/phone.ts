/**
 * tests/support/phone.ts — « téléphone » de test pour les scénarios mobiles
 * (tests/integration/mobile-*.test.ts), avec le code RÉEL de l'app :
 * - choix de la base par `createDepsManager` (deps.factory), session lue localement ;
 * - `SyncedStorage` + `SupabaseSyncRemote`, règles de fusion du core (`lib/sync-merge`) ;
 * - IndexedDB en mémoire fidèle (fake-indexeddb) : fermeture forcée = base abandonnée
 *   sans rien envoyer ; réinstallation = nouvelle IndexedDB vide ;
 * - réseau coupable (coupure franche) et faux serveur 010 (fake-sync-server).
 *
 * Même modèle que la classe `Phone` de sync-scenarios.test.ts (réduite à ce que les
 * scénarios mobiles utilisent), partagée ici pour ne pas la dupliquer dans chaque fichier.
 */
import { expect } from 'vitest';
import { STORAGE_KEYS, type StoragePort } from '@kinetic/core';
import { SupabaseSyncRemote, SyncedStorage } from '@kinetic/adapters-web';
import {
  InMemoryStorage,
  FakeClock,
  SequentialIdGenerator,
  SpyNotifier,
} from '@test-helpers/stubs.ts';
import { createFakeIndexedDB, type FakeIndexedDB } from './fake-indexeddb';
import { FakeSyncServer, type FakeSupabaseClient } from './fake-sync-server';
import { createDepsManager, type DepsManager } from '../../apps/web/src/deps.factory';
import { syncMerge } from '../../apps/web/src/lib/sync-merge';
import { loadSessions } from '../../apps/web/src/lib/training/storage';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types';

export const T0 = Date.parse('2026-11-25T10:00:00.000Z');

type Reply = ReturnType<FakeSupabaseClient['exec']>;

export class Phone {
  idb: IDBFactory;
  fake: FakeIndexedDB;
  readonly events = new EventTarget();
  /** Session Supabase enregistrée sur l'appareil (`kinetic-auth`), même expirée. */
  session: string | null = null;
  navigatorOnline = true;
  netUp = true;
  readonly clock = { ms: T0 };
  readonly client: FakeSupabaseClient;
  private manager: DepsManager | null = null;
  private current: SyncedStorage | null = null;
  private readonly opened: SyncedStorage[] = [];

  constructor(readonly server: FakeSyncServer) {
    const { factory, fake } = createFakeIndexedDB();
    this.idb = factory;
    this.fake = fake;
    this.client = server.client(null);
    const exec = this.client.exec.bind(this.client);
    this.client.exec = (callName: string, run: () => unknown): Reply => {
      if (!this.netUp) {
        server.calls.push({ name: callName, user: this.client.uid });
        return { data: null, error: { code: '', message: 'TypeError: fetch failed' }, status: 0 };
      }
      return exec(callName, run);
    };
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
        }),
    });
    const deps = await this.manager.getDeps();
    expect(deps.storage).toBeInstanceOf(SyncedStorage);
    this.current = deps.storage as SyncedStorage;
    this.opened.push(this.current);
    return this.current;
  }

  /** Démarrage tel que `SyncedStorage.start()` le fait (pull puis push). */
  async startup(): Promise<SyncedStorage> {
    const s = await this.boot();
    await s.sync({ ignoreBackoff: true });
    return s;
  }

  get storage(): SyncedStorage {
    if (!this.current) throw new Error('app non lancée');
    return this.current;
  }

  /** Fermeture forcée (iOS tue l'app) : rien n'est envoyé, la base est abandonnée. */
  kill(): void {
    this.manager?.resetDeps();
    this.manager = null;
    this.current = null;
  }

  /** Réinstallation : l'IndexedDB de l'app est perdue ; la session est à refaire. */
  reinstall(): void {
    this.kill();
    const { factory, fake } = createFakeIndexedDB();
    this.idb = factory;
    this.fake = fake;
    this.session = null;
    this.client.uid = null;
  }

  login(uid: string): void {
    this.session = uid;
    this.client.uid = uid;
  }

  offline(): void {
    this.netUp = false;
    this.navigatorOnline = false;
  }

  online(): void {
    this.netUp = true;
    this.navigatorOnline = true;
  }

  dispose(): void {
    for (const s of this.opened) s.dispose();
  }
}

/** Téléphone déjà connecté à `uid` (session persistée) et lancé. */
export async function phoneOf(server: FakeSyncServer, uid: string): Promise<Phone> {
  const p = new Phone(server);
  p.login(uid);
  await p.startup();
  return p;
}

export function workout(id: string, name: string, reps = 5, day = 24): WorkoutSession {
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

/** Séances vivantes côté serveur : id → nom. */
export function cloudSessions(server: FakeSyncServer, uid: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.live(uid))) {
    if (k.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX)) {
      const s = v as WorkoutSession;
      out[s.id] = s.name;
    }
  }
  return out;
}

/** Séances vues par l'app (loadSessions) : id → nom. */
export async function appSessions(storage: StoragePort): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of await loadSessions(storage)) out[s.id] = s.name;
  return out;
}

export const pushCalls = (server: FakeSyncServer): number =>
  server.calls.filter((c) => c.name === 'sync_push').length;

/** Attend que l'outbox soit vide (synchro automatique lancée par `start()`). */
export async function waitSynced(s: SyncedStorage, tries = 200): Promise<void> {
  for (let i = 0; i < tries && (await s.pendingCount()) > 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

export { FakeSyncServer };
