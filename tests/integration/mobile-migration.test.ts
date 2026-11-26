/**
 * Mobile — mise à jour de l'app sur un téléphone qui a d'anciennes données locales.
 *
 * Chaîne réelle d'un premier lancement après mise à jour : ancienne base `keyval-store`
 * (schéma local v0/v1, séances dans un tableau unique) → base du compte (legacy-migration,
 * déjà couverte par sync-migration.test.ts) → migrations de schéma de l'app
 * (lib/migrations.ts, pliage v2) sur la SyncedStorage → synchro. Ce fichier vérifie
 * l'enchaînement complet et l'échec de migration (audit stockage local F2).
 */
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations';
import { saveSession } from '../../apps/web/src/lib/training/storage';
import { FakeSyncServer, Phone, appSessions, cloudSessions, workout } from '../support/phone';

const ALICE = 'user-alice';
const LEGACY_SESSIONS = STORAGE_KEYS.TRAINING_SESSIONS;

async function seedLegacy(phone: Phone, entries: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = phone.idb.open('keyval-store');
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

/** Premier lancement après la mise à jour : base ouverte (migration locale), migrations de schéma, synchro. */
async function firstLaunch(phone: Phone) {
  const s = await phone.boot();
  await runMigrationsIfNeeded(s);
  await s.sync({ ignoreBackoff: true });
  return s;
}

describe('Mobile — migration d anciennes données locales', () => {
  for (const version of [undefined, 1] as const) {
    it(`schéma local ${version ?? 'absent (v0)'} avec séances en tableau unique : repliées, conservées, synchronisées`, async () => {
      const server = new FakeSyncServer();
      const phone = new Phone(server);
      phone.login(ALICE);
      await seedLegacy(phone, {
        ...(version === undefined ? {} : { [STORAGE_KEYS.SCHEMA_VERSION]: version }),
        [LEGACY_SESSIONS]: [
          workout('old1', 'Ancienne 1', 5, 2),
          workout('old2', 'Ancienne 2', 5, 3),
        ],
        [STORAGE_KEYS.XP]: { xp: 1234 },
        [STORAGE_KEYS.BODYWEIGHT_ENTRIES]: [{ date: '2026-01-02', weight: 81 }],
      });

      const s = await firstLaunch(phone);

      expect(await s.get(STORAGE_KEYS.SCHEMA_VERSION)).toBe(2);
      expect(await s.get(LEGACY_SESSIONS)).toBeNull();
      expect(await appSessions(s)).toEqual({ old1: 'Ancienne 1', old2: 'Ancienne 2' });
      expect(await s.get(STORAGE_KEYS.XP)).toEqual({ xp: 1234 });
      // Cloud : une clé par séance, ni l'ancien tableau ni la version de schéma (propre à l'appareil).
      expect(cloudSessions(server, ALICE)).toEqual({ old1: 'Ancienne 1', old2: 'Ancienne 2' });
      const live = server.live(ALICE);
      expect(live[LEGACY_SESSIONS]).toBeUndefined();
      expect(live[STORAGE_KEYS.SCHEMA_VERSION]).toBeUndefined();
      expect(live[STORAGE_KEYS.BODYWEIGHT_ENTRIES]).toEqual([{ date: '2026-01-02', weight: 81 }]);

      // Relance : rien n'est rejoué.
      phone.kill();
      const again = await firstLaunch(phone);
      expect(await appSessions(again)).toEqual({ old1: 'Ancienne 1', old2: 'Ancienne 2' });
      phone.dispose();
    });
  }

  it('pliage v2 interrompu (stockage plein) pendant qu une séance est terminée : rien n est perdu, migration rejouée au lancement suivant', async () => {
    const server = new FakeSyncServer();
    const phone = new Phone(server);
    phone.login(ALICE);
    await seedLegacy(phone, {
      [STORAGE_KEYS.SCHEMA_VERSION]: 1,
      [LEGACY_SESSIONS]: [workout('old1', 'Ancienne 1', 5, 2), workout('old2', 'Ancienne 2', 5, 3)],
    });
    const s = await phone.boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Le 2e pliage échoue (quota) ; au même moment l'utilisateur termine sa séance du jour.
    phone.fake.failNext(
      (op) =>
        op.kind === 'put' &&
        op.store === 'kv' &&
        op.key === `${STORAGE_KEYS.TRAINING_SESSION_PREFIX}old2`,
      'QuotaExceededError',
    );
    const today = saveSession(s, workout('today', 'Séance du jour', 5, 25));
    await expect(runMigrationsIfNeeded(s)).rejects.toThrow();
    await today;

    // La séance du jour est là ; l'ancien tableau aussi (rien de perdu) ; version inchangée.
    expect(await s.get(`${STORAGE_KEYS.TRAINING_SESSION_PREFIX}today`)).not.toBeNull();
    expect(await s.get(LEGACY_SESSIONS)).toHaveLength(2);
    expect(await s.get(STORAGE_KEYS.SCHEMA_VERSION)).toBe(1);
    await s.sync({ ignoreBackoff: true });
    expect(cloudSessions(server, ALICE)).toMatchObject({ today: 'Séance du jour' });

    // Lancement suivant : la migration réussit, tout est là, localement et dans le cloud.
    phone.kill();
    const next = await firstLaunch(phone);
    expect(await next.get(STORAGE_KEYS.SCHEMA_VERSION)).toBe(2);
    expect(await appSessions(next)).toEqual({
      old1: 'Ancienne 1',
      old2: 'Ancienne 2',
      today: 'Séance du jour',
    });
    expect(cloudSessions(server, ALICE)).toEqual({
      old1: 'Ancienne 1',
      old2: 'Ancienne 2',
      today: 'Séance du jour',
    });
    vi.restoreAllMocks();
    phone.dispose();
  });
});
