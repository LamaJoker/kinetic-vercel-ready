/**
 * Mobile — sauvegarde complète puis restauration, aller-retour sans perte.
 *
 * Code réel : `buildFullBackup` (sauvegarde automatique de l'app native, identique à
 * l'export JSON), `parseKineticJson`, `previewRestore` / `restoreBackup` /
 * `undoLastRestore` (lib/backup.ts, audit F5/F6) et `mergeIntoStorage`, sur la
 * SyncedStorage d'un téléphone réinstallé (IndexedDB en mémoire), puis synchro.
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS, type StoragePort } from '@kinetic/core';
import { buildFullBackup } from '../../apps/web/src/lib/auto-backup';
import {
  previewRestore,
  restoreBackup,
  snapshotStorage,
  undoLastRestore,
} from '../../apps/web/src/lib/backup';
import { mergeIntoStorage, parseKineticJson } from '../../apps/web/src/lib/training/import';
import {
  loadCustomExercises,
  loadSessions,
  saveCustomExercises,
  saveSession,
  saveTemplates,
} from '../../apps/web/src/lib/training/storage';
import { writeActiveSession } from '../../apps/web/src/lib/training/active-session';
import { runMigrationsIfNeeded } from '../../apps/web/src/lib/migrations';
import type { Exercise } from '../../apps/web/src/lib/training/types';
import { FakeSyncServer, cloudSessions, phoneOf, workout } from '../support/phone';

const ALICE = 'user-alice';

const custom: Exercise = {
  id: 'custom-landmine',
  name: 'Landmine press',
  custom: true,
} as unknown as Exercise;

async function fillDevice(s: StoragePort): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const w = workout(`w${i}`, `Séance ${i}`, 5 + i, 18 + i);
    w.entries[0]!.exerciseId = i === 4 ? custom.id : 'squat';
    await saveSession(s, w);
  }
  await saveCustomExercises(s, [custom]);
  await saveTemplates(s, [
    { id: 't1', name: 'Push', createdAt: '2026-11-01T00:00:00.000Z', exercises: [] },
  ]);
  await s.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [
    { date: '2026-11-18', weight: 80.4, bodyFatPct: null, note: null },
    { date: '2026-11-22', weight: 80.1, bodyFatPct: 16, note: 'matin' },
  ]);
  await s.set(STORAGE_KEYS.MEASUREMENTS_ENTRIES, [{ id: 'm1', date: '2026-11-20', waist: 84 }]);
  await s.set(STORAGE_KEYS.NUTRITION_LOG('2026-11-24'), [
    { id: 'meal-1', mealName: 'Déjeuner', loggedAt: '2026-11-24T12:00:00.000Z', items: [] },
  ]);
  await s.set(STORAGE_KEYS.USER_PROFILE, { name: 'Alice', goal: 'force' });
  await s.set(STORAGE_KEYS.XP, { xp: 4200 });
  // État propre à l'appareil : ne doit pas voyager dans la sauvegarde.
  await runMigrationsIfNeeded(s);
  await s.set(STORAGE_KEYS.PENDING_TASK_MUTATION, { taskId: 'water', xp: 10 });
  await writeActiveSession(s, {
    v: 1,
    session: { id: 'live', name: 'En cours', startedAt: '2026-11-25T09:00:00.000Z', entries: [] },
    restEndsAtMs: 0,
    restTotalSec: 90,
    restPresetSec: 90,
    activeExerciseId: null,
    savedAtMs: 0,
  });
}

describe('Mobile — sauvegarde complète et restauration', () => {
  it('aller-retour sur un téléphone réinstallé : toutes les données reviennent, sans état propre à l appareil, puis partent au cloud', async () => {
    const server = new FakeSyncServer();
    // Téléphone d'origine : compte sans synchro réussie (sauvegarde = seule copie).
    const source = await phoneOf(server, ALICE);
    source.offline();
    await fillDevice(source.storage);
    const file = await buildFullBackup(source.storage);
    const expectedData = await snapshotStorage(source.storage);
    const expectedSessions = await loadSessions(source.storage);
    source.dispose();

    const bundle = parseKineticJson(file);
    expect(bundle.sessions).toHaveLength(5);
    expect(bundle.data?.[STORAGE_KEYS.SCHEMA_VERSION]).toBeUndefined();
    expect(bundle.data?.[STORAGE_KEYS.PENDING_TASK_MUTATION]).toBeUndefined();
    expect(bundle.data?.[STORAGE_KEYS.TRAINING_ACTIVE_SESSION]).toBeUndefined();

    // Nouveau téléphone (le cloud ne connaît rien : l'ancien n'avait jamais synchronisé).
    const target = await phoneOf(server, ALICE);
    const s = target.storage;
    const preview = await previewRestore(s, bundle);
    expect(preview.sessions).toBe(5);
    expect(preview.tooNew).toBe(false);
    await restoreBackup(s, bundle, (j) => mergeIntoStorage(j, bundle, 'kinetic-json'));

    expect(await snapshotStorage(s)).toEqual(expectedData);
    expect(await loadSessions(s)).toEqual(expectedSessions);
    expect((await loadCustomExercises(s)).map((e) => e.id)).toContain(custom.id);
    expect(await s.get(STORAGE_KEYS.PENDING_TASK_MUTATION)).toBeNull();
    expect(await s.get(STORAGE_KEYS.TRAINING_ACTIVE_SESSION)).toBeNull();

    await s.sync({ ignoreBackoff: true });
    expect(Object.keys(cloudSessions(server, ALICE)).sort()).toEqual([
      'w0',
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(server.live(ALICE)[STORAGE_KEYS.BODYWEIGHT_ENTRIES]).toEqual(
      expectedData[STORAGE_KEYS.BODYWEIGHT_ENTRIES],
    );
    // La copie de secours de la restauration reste sur l'appareil.
    expect(server.live(ALICE)[STORAGE_KEYS.BACKUP_RESTORE_UNDO]).toBeUndefined();
    target.dispose();
  });

  it('restauration d une vieille sauvegarde par erreur : « Annuler » remet exactement l état d avant (séances et pesées comprises)', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    const s = phone.storage;
    await s.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [{ date: '2026-10-01', weight: 82 }]);
    await saveSession(s, workout('old', 'Ancienne', 5, 1));
    const oldBackup = parseKineticJson(await buildFullBackup(s));

    // Un mois plus tard : nouvelles pesées et séances.
    await s.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [
      { date: '2026-10-01', weight: 82 },
      { date: '2026-11-01', weight: 80 },
    ]);
    await saveSession(s, workout('recent', 'Récente', 5, 24));
    await s.flushPendingWrites();
    const before = await snapshotStorage(s);
    const sessionsBefore = await loadSessions(s);

    const preview = await previewRestore(s, oldBackup);
    expect(preview.lines).toContainEqual({ label: 'Pesées', inBackup: 1, onDevice: 2 });
    await restoreBackup(s, oldBackup, (j) => mergeIntoStorage(j, oldBackup, 'kinetic-json'));
    expect(await s.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toHaveLength(1);
    // Les séances ne sont jamais retirées par une restauration (seulement ajoutées).
    expect(Object.keys(cloudSessions(server, ALICE)).sort()).toEqual(['old', 'recent']);

    await undoLastRestore(s);
    expect(await snapshotStorage(s)).toEqual(before);
    expect(await loadSessions(s)).toEqual(sessionsBefore);
    await s.sync({ ignoreBackoff: true });
    expect(server.live(ALICE)[STORAGE_KEYS.BODYWEIGHT_ENTRIES]).toEqual(
      before[STORAGE_KEYS.BODYWEIGHT_ENTRIES],
    );
    phone.dispose();
  });
});
