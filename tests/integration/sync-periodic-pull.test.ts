/**
 * PERF-09 (audit performance) : la synchro cloud → appareil ne se limite plus au
 * démarrage. Tant que l'app est visible, SyncedStorage tire les changements des autres
 * appareils à intervalle régulier, et aussi au retour au premier plan ; app masquée,
 * aucun appel réseau périodique. Vrai client contre le faux serveur 010.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevice, FakeSyncServer } from '../support/sync-harness';

const U = 'user-a';
const KEY = 'kinetic:training:session:s1';

/** Fenêtre et document minimaux : les déclencheurs n'existent que dans un navigateur. */
function installBrowserGlobals(): { setVisible(v: boolean): void } {
  const win = new EventTarget();
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = 'visible';
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  return {
    setVisible(v) {
      doc.visibilityState = v ? 'visible' : 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

const pulls = (server: FakeSyncServer): number =>
  server.calls.filter((c) => c.name.startsWith('sync_pull')).length;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PERF-09 : pull périodique tant que l app est visible', () => {
  it('une séance écrite sur un autre appareil arrive sans redémarrage ni action', async () => {
    installBrowserGlobals();
    const server = new FakeSyncServer();
    const phone = await createDevice(server).open(U, { autoSync: true, pullIntervalMs: 40 });
    phone.start();
    await waitFor(() => pulls(server) >= 1);

    const tablet = await createDevice(server).open(U);
    await tablet.set(KEY, { id: 's1', name: 'Jambes' });
    await tablet.flushPendingWrites();

    await waitFor(() => server.live(U)[KEY] !== undefined);
    let seen: unknown = null;
    for (let i = 0; i < 100 && seen === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
      seen = await phone.get(KEY);
    }
    expect(seen).toEqual({ id: 's1', name: 'Jambes' });
    phone.dispose();
    tablet.dispose();
  });

  it('app masquée : aucun pull périodique ; retour au premier plan : pull immédiat', async () => {
    const browser = installBrowserGlobals();
    const server = new FakeSyncServer();
    const phone = await createDevice(server).open(U, { autoSync: true, pullIntervalMs: 20 });
    phone.start();
    await waitFor(() => pulls(server) >= 1);
    await new Promise((r) => setTimeout(r, 30));

    browser.setVisible(false);
    await new Promise((r) => setTimeout(r, 30));
    const whileHidden = pulls(server);
    await new Promise((r) => setTimeout(r, 120));
    expect(pulls(server)).toBe(whileHidden);

    browser.setVisible(true);
    await waitFor(() => pulls(server) > whileHidden);
    expect(pulls(server)).toBeGreaterThan(whileHidden);
    phone.dispose();
  });

  it('dispose : le minuteur est arrêté, plus aucun appel', async () => {
    installBrowserGlobals();
    const server = new FakeSyncServer();
    const phone = await createDevice(server).open(U, { autoSync: true, pullIntervalMs: 20 });
    phone.start();
    await waitFor(() => pulls(server) >= 1);
    phone.dispose();
    await new Promise((r) => setTimeout(r, 30));
    const after = pulls(server);
    await new Promise((r) => setTimeout(r, 100));
    expect(pulls(server)).toBe(after);
  });
});
