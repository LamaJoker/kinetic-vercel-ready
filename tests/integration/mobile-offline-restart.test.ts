/**
 * Mobile — redémarrages sans réseau, reprise après perte de réseau, reconnexion.
 *
 * Complète sync-scenarios.test.ts › « Mobile » (un redémarrage, une coupure) par les
 * enchaînements réels d'une salle sans réseau : plusieurs fermetures forcées hors-ligne,
 * réseau qui revient au milieu, jeton expiré pendant la coupure puis reconnexion.
 * Code réel : deps.factory → SyncedStorage → SupabaseSyncRemote, faux serveur 010.
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { saveSession } from '../../apps/web/src/lib/training/storage';
import {
  FakeSyncServer,
  appSessions,
  cloudSessions,
  phoneOf,
  pushCalls,
  waitSynced,
  workout,
} from '../support/phone';

const ALICE = 'user-alice';

describe('Mobile — séances non synchronisées et redémarrages', () => {
  it('trois séances sur trois jours sans réseau, app tuée à chaque fois : toutes envoyées une seule fois au retour du réseau', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    phone.offline();
    for (const [i, day] of [22, 23, 24].entries()) {
      const s = i === 0 ? phone.storage : await phone.boot(); // relancée hors-ligne
      s.start(); // synchro auto : rien ne part, rien ne casse
      await saveSession(s, workout(`w${day}`, `Jour ${day}`, 5, day));
      await s.flushPendingWrites();
      expect(await s.pendingCount()).toBeGreaterThan(0);
      phone.kill();
      phone.clock.ms += 24 * 3600_000;
    }
    expect(cloudSessions(server, ALICE)).toEqual({});

    phone.online();
    const s = await phone.boot();
    s.start(); // chemin réel : onStorageReady → start()
    await waitSynced(s);
    expect(cloudSessions(server, ALICE)).toEqual({
      w22: 'Jour 22',
      w23: 'Jour 23',
      w24: 'Jour 24',
    });
    // Aucun doublon, rien en attente, les séances locales sont intactes.
    expect(
      Object.keys(server.live(ALICE)).filter((k) =>
        k.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX),
      ),
    ).toHaveLength(3);
    expect(await s.pendingCount()).toBe(0);
    expect(Object.keys(await appSessions(s)).sort()).toEqual(['w22', 'w23', 'w24']);
    const calls = pushCalls(server);
    await s.sync({ ignoreBackoff: true });
    expect(pushCalls(server)).toBe(calls); // plus rien à renvoyer
    phone.dispose();
  });

  it('perte de réseau en pleine synchro puis retour : reprise sans perte ni doublon', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    await saveSession(phone.storage, workout('a', 'A'));
    phone.netUp = false; // réseau « connecté » mais rien ne passe (ascenseur, métro)
    await phone.storage.flushPendingWrites();
    await saveSession(phone.storage, workout('b', 'B'));
    phone.kill(); // l'utilisateur ferme l'app, dépité
    phone.netUp = true;
    phone.clock.ms += 60_000;
    const s = await phone.startup(); // relancée : backoff ignoré au démarrage
    expect(cloudSessions(server, ALICE)).toEqual({ a: 'A', b: 'B' });
    expect(await s.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
    phone.dispose();
  });

  it('jeton expiré pendant la coupure, rafraîchissement impossible : rien n est perdu, tout part après reconnexion', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    phone.offline();
    await saveSession(phone.storage, workout('w1', 'Hors-ligne'));
    server.expireSession(ALICE);
    server.refreshFails = true;
    phone.online();
    await phone.storage.flushPendingWrites({ ignoreBackoff: true });
    expect((await phone.storage.getStatus()).state).toBe('auth_required');
    expect(await phone.storage.pendingCount()).toBe(1);
    phone.kill();

    // L'utilisateur se reconnecte (même compte) : la base du compte est rouverte telle quelle.
    server.refreshFails = false;
    phone.login(ALICE);
    const s = await phone.startup();
    expect(cloudSessions(server, ALICE)).toEqual({ w1: 'Hors-ligne' });
    expect(await s.pendingCount()).toBe(0);
    phone.dispose();
  });
});
