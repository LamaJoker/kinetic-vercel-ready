/**
 * Revue adversariale « concurrence et réseau » : remise à zéro locale (« Effacer les
 * données de cet appareil », « Supprimer toutes mes données cloud ») pendant qu'un appel
 * réseau de synchro est EN VOL.
 *
 * Ces deux actions ne prennent pas le verrou de synchro (elles ne doivent pas attendre un
 * réseau qui pend) : la réponse d'un pull ou d'un push lancé AVANT doit donc être ignorée
 * si l'état local a été remis à zéro entre-temps, sinon :
 *  - pull : la page en vol réécrit le curseur et « premier pull fait » dans la base vidée,
 *    l'appareil ne retélécharge plus jamais les données plus anciennes que la page ;
 *  - push : la réponse « ok » d'un ancien envoi efface l'entrée d'outbox d'une écriture
 *    faite APRÈS la remise à zéro (même `rev`), qui n'est alors jamais envoyée (et
 *    supprimée localement par la suppression totale qui suit).
 */
import { describe, expect, it } from 'vitest';
import { SupabaseSyncRemote, type SyncRemote } from '@kinetic/adapters-web';
import type {
  PullPage,
  PushItem,
  PushResult,
  RemoteKeyState,
} from '../../packages/adapter-web/src/sync/remote';
import { createDevice, FakeSyncServer, type Device } from '../support/sync-harness';

const ALICE = 'user-alice';
const S = (id: string): string => `kinetic:training:session:${id}`;

/** Remote réel dont on peut retenir la PROCHAINE réponse d'un appel (réponse « en vol »). */
class GatedRemote implements SyncRemote {
  private gates = new Map<string, { reached: () => void; release: Promise<void> }>();
  constructor(private readonly inner: SupabaseSyncRemote) {}

  /** La prochaine réponse de `name` attend `release()` ; `reached` résout quand l'appel a eu lieu. */
  hold(name: 'push' | 'pull'): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const releaseP = new Promise<void>((r) => (release = r));
    const reachedP = new Promise<void>((r) => (reached = r));
    this.gates.set(name, { reached, release: releaseP });
    return { reached: reachedP, release };
  }

  private async gated<T>(name: string, call: () => Promise<T>): Promise<T> {
    const gate = this.gates.get(name);
    const result = await call();
    if (gate) {
      this.gates.delete(name);
      gate.reached();
      await gate.release;
    }
    return result;
  }

  push(items: readonly PushItem[]): Promise<PushResult[]> {
    return this.gated('push', () => this.inner.push(items));
  }
  pull(since: string | null, afterKey: string, limit: number): Promise<PullPage> {
    return this.gated('pull', () => this.inner.pull(since, afterKey, limit));
  }
  deleteAll(): Promise<{ deleted_count: number; updated_at: string | null }> {
    return this.inner.deleteAll();
  }
  fetchKey(key: string): Promise<RemoteKeyState | null> {
    return this.inner.fetchKey(key);
  }
  refreshSession(): Promise<boolean> {
    return this.inner.refreshSession();
  }
}

function gatedDevice(server: FakeSyncServer): { dev: Device; remote: GatedRemote } {
  const dev = createDevice(server);
  const remote = new GatedRemote(new SupabaseSyncRemote(dev.client(ALICE) as never, ALICE));
  return { dev, remote };
}

describe('remise à zéro locale pendant un appel de synchro en vol', () => {
  it('« Effacer les données de cet appareil » pendant un pull : tout revient au prochain lancement', async () => {
    const server = new FakeSyncServer();
    for (const id of ['a', 'b', 'c']) {
      server.advance(1000);
      server.seed(ALICE, S(id), { id, note: `séance ${id}` });
    }
    const { dev, remote } = gatedDevice(server);
    const phone = await dev.open(ALICE, { remote });
    await phone.sync();
    expect([...(await phone.keys())].sort()).toEqual([S('a'), S('b'), S('c')]);

    // Une séance faite ailleurs ; le pull qui la ramène est en vol quand l'utilisateur efface.
    server.advance(1000);
    server.seed(ALICE, S('d'), { id: 'd', note: 'séance d' });
    const gate = remote.hold('pull');
    const pulling = phone.pull();
    await gate.reached;
    await phone.clear();
    gate.release();
    await pulling;

    // Rechargement de l'app (doReset recharge la page) puis synchro.
    phone.dispose();
    const again = await dev.open(ALICE, { remote });
    await again.sync();
    expect([...(await again.keys())].sort()).toEqual([S('a'), S('b'), S('c'), S('d')]);
    again.dispose();
  });

  it('« Effacer les données de cet appareil » pendant un push : une écriture faite après part bien', async () => {
    const server = new FakeSyncServer();
    const { dev, remote } = gatedDevice(server);
    const phone = await dev.open(ALICE, { remote });
    await phone.sync();

    await phone.set('kinetic:settings', { unit: 'kg' });
    const gate = remote.hold('push');
    const flushing = phone.flushPendingWrites();
    await gate.reached;
    await phone.clear();
    // Écriture APRÈS l'effacement, même clé : nouvelle entrée d'outbox (rev 1).
    await phone.set('kinetic:settings', { unit: 'lb' });
    gate.release();
    await flushing;

    await phone.flushPendingWrites({ ignoreBackoff: true });
    expect(await phone.pendingCount()).toBe(0);
    expect(server.live(ALICE)['kinetic:settings']).toEqual({ unit: 'lb' });
    phone.dispose();
  });

  it('« Supprimer toutes mes données cloud » pendant un push : la séance enregistrée juste après survit', async () => {
    const server = new FakeSyncServer();
    const { dev, remote } = gatedDevice(server);
    const phone = await dev.open(ALICE, { remote });
    await phone.sync();

    await phone.set(S('old'), { id: 'old', v: 1 });
    const gate = remote.hold('push');
    const flushing = phone.flushPendingWrites();
    await gate.reached;
    // Demande inscrite (persistée) pendant que l'envoi précédent attend sa réponse.
    const deleting = phone.deleteAllCloudData();
    while (!(await phone.getStatus()).deleteAllPending) await Promise.resolve();
    // Séance réenregistrée APRÈS la demande (même clé, entrée rev 1) : elle doit survivre.
    await phone.set(S('old'), { id: 'old', v: 2 });
    gate.release();
    await flushing;
    await deleting;

    await phone.flushPendingWrites({ ignoreBackoff: true });
    expect(await phone.get(S('old'))).toEqual({ id: 'old', v: 2 });
    expect(server.live(ALICE)).toEqual({ [S('old')]: { id: 'old', v: 2 } });
    expect(await phone.pendingCount()).toBe(0);
    phone.dispose();
  });
});
