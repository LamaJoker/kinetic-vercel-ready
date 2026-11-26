/**
 * tests/support/sync-harness.ts — appareils de test (IndexedDB en mémoire + faux serveur 010).
 */
import {
  SyncedStorage,
  SupabaseSyncRemote,
  type SyncedStorageOptions,
} from '@kinetic/adapters-web';
import { defaultMergeRegistry, planGuestMerge } from '@kinetic/core';
import { createFakeIndexedDB, type FakeIndexedDB } from './fake-indexeddb';
import { FakeSyncServer, type FakeSupabaseClient } from './fake-sync-server';

export interface Device {
  factory: IDBFactory;
  fake: FakeIndexedDB;
  events: EventTarget;
  /** Événements reçus (nom → détails). */
  received: Array<{ name: string; detail: unknown }>;
  online: { value: boolean };
  open(owner: string, extra?: Partial<SyncedStorageOptions>): Promise<SyncedStorage>;
  client(owner: string): FakeSupabaseClient;
}

export function createDevice(server: FakeSyncServer): Device {
  const { factory, fake } = createFakeIndexedDB();
  const events = new EventTarget();
  const received: Device['received'] = [];
  for (const name of [
    'kinetic:sync-status',
    'kinetic:sync-applied',
    'kinetic:notify',
    'kinetic:sync-failed',
  ]) {
    events.addEventListener(name, (ev) =>
      received.push({ name, detail: (ev as CustomEvent).detail }),
    );
  }
  const online = { value: true };
  const clients = new Map<string, FakeSupabaseClient>();
  const client = (owner: string): FakeSupabaseClient => {
    let c = clients.get(owner);
    if (!c) clients.set(owner, (c = server.client(owner)));
    return c;
  };
  return {
    factory,
    fake,
    events,
    received,
    online,
    client,
    open(owner, extra = {}) {
      const remote =
        owner === 'guest' ? null : new SupabaseSyncRemote(client(owner) as never, owner);
      return SyncedStorage.open({
        owner,
        remote,
        factory,
        autoSync: false,
        eventTarget: events,
        isOnline: () => online.value,
        // Registre `lww` par défaut (les tests de stratégie passent `registry`) ; fusion
        // invité réelle du core.
        loadMerge: async () => ({ registry: defaultMergeRegistry, planGuestMerge }),
        ...extra,
      });
    },
  };
}

export { FakeSyncServer };

/** Lit tout un store d'une base de l'appareil (assertions). */
export function dump(device: Device, db: string, store: string): Record<string, unknown> {
  return Object.fromEntries(
    [...device.fake.dump(db, store).entries()].map(([k, v]) => [String(k), v]),
  );
}
