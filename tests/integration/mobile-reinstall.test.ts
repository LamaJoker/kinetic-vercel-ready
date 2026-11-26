/**
 * Mobile — réinstallation de l'app (IndexedDB perdue) puis reconnexion au compte.
 *
 * Complète sync-scenarios.test.ts › « Réinstallation / nouvel appareil » (modèles) par
 * un jeu de données complet et le chemin de démarrage réel (migrations de schéma de
 * main.ts comprises) : tout revient du cloud, et rien n'est réécrit sur le serveur.
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations';
import { loadTemplates, saveSession, saveTemplates } from '../../apps/web/src/lib/training/storage';
import { writeActiveSession } from '../../apps/web/src/lib/training/active-session';
import type { WorkoutTemplate } from '../../apps/web/src/lib/training/types';
import {
  FakeSyncServer,
  appSessions,
  cloudSessions,
  phoneOf,
  pushCalls,
  workout,
} from '../support/phone';

const ALICE = 'user-alice';

const template = (id: string, name: string): WorkoutTemplate => ({
  id,
  name,
  createdAt: '2026-11-01T00:00:00.000Z',
  exercises: [],
});

/** Démarrage comme main.ts : base du compte, migrations de schéma, puis synchro. */
async function launch(phone: Awaited<ReturnType<typeof phoneOf>>) {
  const s = await phone.boot();
  await runMigrationsIfNeeded(s);
  await s.sync({ ignoreBackoff: true });
  return s;
}

describe('Mobile — réinstallation', () => {
  it('base vide + reconnexion : toutes les données du cloud reviennent, rien n est écrasé ni renvoyé', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    const s0 = phone.storage;
    for (let i = 0; i < 4; i++) await saveSession(s0, workout(`w${i}`, `Séance ${i}`, 5, 20 + i));
    await saveTemplates(s0, [template('mine', 'Mon programme')]);
    await s0.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-20', weight: 80.2 }]);
    await s0.set(STORAGE_KEYS.USER_PROFILE, { name: 'Alice', goal: 'force' });
    await s0.set(STORAGE_KEYS.XP, { xp: 4200 });
    await writeActiveSession(s0, null);
    await s0.flushPendingWrites();
    const versionsBefore = Object.fromEntries(
      Object.keys(server.live(ALICE)).map((k) => [k, server.row(ALICE, k)?.updated_at]),
    );

    phone.reinstall(); // AltStore / suppression de l'app : IndexedDB perdue
    phone.login(ALICE);
    const calls = pushCalls(server);
    const s = await launch(phone);

    expect(Object.keys(await appSessions(s)).sort()).toEqual(['w0', 'w1', 'w2', 'w3']);
    expect((await loadTemplates(s)).map((t) => t.id)).toEqual(['mine']);
    expect(await s.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toEqual([
      { date: '2026-11-20', weight: 80.2 },
    ]);
    expect(await s.get(STORAGE_KEYS.USER_PROFILE)).toEqual({ name: 'Alice', goal: 'force' });
    expect(await s.get(STORAGE_KEYS.XP)).toEqual({ xp: 4200 });
    // Aucun envoi : ni défauts, ni version de schéma, ni réécriture des valeurs tirées.
    expect(pushCalls(server)).toBe(calls);
    for (const [k, v] of Object.entries(versionsBefore)) {
      expect(server.row(ALICE, k)?.updated_at).toBe(v);
    }
    phone.dispose();
  });

  it('réinstallation hors-ligne, séance et pesée faites avant le premier pull : fusionnées avec le cloud, rien n est perdu', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    await saveSession(phone.storage, workout('old', 'Historique', 5, 20));
    await phone.storage.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-20', weight: 80 }]);
    await phone.storage.flushPendingWrites();

    phone.reinstall();
    phone.login(ALICE);
    phone.offline();
    const s = await phone.boot();
    await runMigrationsIfNeeded(s);
    await saveSession(s, workout('new', 'Salle sans réseau', 5, 25));
    await s.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-11-25', weight: 79.5 }]);

    phone.online();
    await s.sync({ ignoreBackoff: true });
    await s.sync({ ignoreBackoff: true });

    expect(cloudSessions(server, ALICE)).toEqual({ old: 'Historique', new: 'Salle sans réseau' });
    const weights = (
      server.live(ALICE)[STORAGE_KEYS.BODYWEIGHT_ENTRIES] as Array<{ date: string }>
    ).map((e) => e.date);
    expect(weights.sort()).toEqual(['2026-11-20', '2026-11-25']);
    expect(Object.keys(await appSessions(s)).sort()).toEqual(['new', 'old']);
    phone.dispose();
  });
});
