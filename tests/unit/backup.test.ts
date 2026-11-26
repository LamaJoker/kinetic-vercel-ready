import { describe, it, expect } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  isBackedUpKey,
  isBackupTooNew,
  lastRestoreUndo,
  previewRestore,
  restoreBackup,
  restoreStorage,
  snapshotStorage,
  undoLastRestore,
} from '../../apps/web/src/lib/backup.js';
import { LOCAL_SCHEMA_VERSION } from '../../apps/web/src/lib/schema-version.js';
import { buildJsonExport } from '../../apps/web/src/lib/training/export.js';
import { mergeIntoStorage, parseKineticJson } from '../../apps/web/src/lib/training/import.js';
import { InMemoryStorage } from '../helpers/stubs.js';

describe('isBackedUpKey', () => {
  it("garde les données de l'application", () => {
    expect(isBackedUpKey('kinetic:bodyweight:entries')).toBe(true);
    expect(isBackedUpKey('kinetic:xp')).toBe(true);
  });

  it('écarte séances, exercices et clés propres à cet appareil', () => {
    expect(isBackedUpKey('kinetic:training:session:abc')).toBe(false);
    expect(isBackedUpKey('kinetic:training:sessions')).toBe(false);
    expect(isBackedUpKey('kinetic:training:exercises')).toBe(false);
    expect(isBackedUpKey('kinetic:sync:outbox')).toBe(false);
    expect(isBackedUpKey('kinetic:deviceId')).toBe(false);
    expect(isBackedUpKey('_kinetic:initial-sync-done')).toBe(false);
    expect(isBackedUpKey('autre-app:clé')).toBe(false);
  });
});

describe('sauvegarde complète', () => {
  it('copie puis restaure les données sur un autre appareil', async () => {
    const source = new InMemoryStorage();
    await source.set('kinetic:bodyweight:entries', [{ date: '2026-05-01', weight: 80 }]);
    await source.set('kinetic:xp', { xp: 1200 });
    await source.set('kinetic:sync:outbox', ['ne pas copier']);

    const data = await snapshotStorage(source);
    expect(Object.keys(data)).toEqual(['kinetic:bodyweight:entries', 'kinetic:xp']);

    const bundle = parseKineticJson(buildJsonExport([], [], data));
    expect(bundle.data).toEqual(data);

    const target = new InMemoryStorage();
    await target.set('kinetic:xp', { xp: 0 });
    expect(await restoreStorage(target, { ...bundle.data!, 'kinetic:deviceId': 'x' })).toBe(2);
    expect(await target.get('kinetic:xp')).toEqual({ xp: 1200 });
    expect(await target.get('kinetic:deviceId')).toBeNull();
  });

  it("un ancien export (version 1) n'a pas de données complémentaires", () => {
    const json = buildJsonExport([], []);
    expect(JSON.parse(json).version).toBe(1);
    expect(parseKineticJson(json).data).toBeUndefined();
    expect(JSON.parse(buildJsonExport([], [], {})).version).toBe(2);
  });
});

// ─── Audit stockage local F5 / F6 ─────────────────────────────────────────

describe('F6 : état propre à l appareil exclu de la sauvegarde', () => {
  it('version de schéma, verrou, mutation de tâche en attente, annulation : jamais copiés ni restaurés', async () => {
    for (const key of [
      STORAGE_KEYS.SCHEMA_VERSION,
      STORAGE_KEYS.SCHEMA_MIGRATION_LOCK,
      STORAGE_KEYS.PENDING_TASK_MUTATION,
      STORAGE_KEYS.SYNC_FALLBACK_JOURNAL,
      STORAGE_KEYS.SYNC_MIGRATED_TO,
      STORAGE_KEYS.BACKUP_RESTORE_UNDO,
    ]) {
      expect(isBackedUpKey(key)).toBe(false);
    }
    const target = new InMemoryStorage();
    await target.set(STORAGE_KEYS.SCHEMA_VERSION, 2);
    await restoreStorage(target, {
      [STORAGE_KEYS.SCHEMA_VERSION]: 1,
      [STORAGE_KEYS.PENDING_TASK_MUTATION]: { taskId: 'x', xp: 50 },
    });
    expect(await target.get(STORAGE_KEYS.SCHEMA_VERSION)).toBe(2);
    expect(await target.get(STORAGE_KEYS.PENDING_TASK_MUTATION)).toBeNull();
  });

  it('la sauvegarde porte la version du schéma ; une sauvegarde plus récente est refusée', async () => {
    const json = buildJsonExport([], [], { 'kinetic:xp': { xp: 1 } });
    expect(JSON.parse(json).schemaVersion).toBe(LOCAL_SCHEMA_VERSION);
    const bundle = parseKineticJson(json);
    expect(bundle.schemaVersion).toBe(LOCAL_SCHEMA_VERSION);
    expect(isBackupTooNew(bundle)).toBe(false);

    const future = { ...bundle, schemaVersion: LOCAL_SCHEMA_VERSION + 1 };
    const target = new InMemoryStorage();
    await target.set('kinetic:xp', { xp: 500 });
    expect((await previewRestore(target, future)).tooNew).toBe(true);
    await expect(restoreBackup(target, future, async () => undefined)).rejects.toThrow(
      'version plus récente',
    );
    expect(await target.get('kinetic:xp')).toEqual({ xp: 500 });
  });
});

describe('F5 : restauration avec aperçu et annulation', () => {
  async function device(): Promise<InMemoryStorage> {
    const s = new InMemoryStorage();
    await s.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [
      { date: '2026-10-01', weight: 80 },
      { date: '2026-11-01', weight: 79 },
    ]);
    await s.set(STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES, [
      { id: 'old', name: 'Ancien', custom: true },
      { id: 'new-since-backup', name: 'Récent', custom: true },
    ]);
    await s.set('kinetic:training:session:mine', {
      id: 'mine',
      name: 'Récente',
      startedAt: '2026-11-20T10:00:00Z',
      entries: [],
    });
    await s.set('kinetic:xp', { xp: 900 });
    return s;
  }
  const backup = {
    sessions: [
      { id: 'from-backup', name: 'Sauvegardée', startedAt: '2026-09-01T10:00:00Z', entries: [] },
    ],
    exercises: [],
    createdExercises: [],
    exportedAt: '2026-10-05T08:00:00.000Z',
    data: {
      [STORAGE_KEYS.BODYWEIGHT_ENTRIES]: [{ date: '2026-10-01', weight: 80 }],
      [STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES]: [
        { id: 'old', name: 'Ancien (modifié)', custom: true },
      ],
      'kinetic:xp': { xp: 300 },
    },
  };

  it('aperçu : ce qui sera remplacé, comparé à l appareil, sans rien écrire', async () => {
    const s = await device();
    const before = s.snapshot();
    const preview = await previewRestore(s, backup);
    expect(preview).toMatchObject({
      exportedAt: '2026-10-05T08:00:00.000Z',
      sessions: 1,
      keys: 3,
      tooNew: false,
    });
    expect(preview.lines).toEqual(
      expect.arrayContaining([
        { label: 'Pesées', inBackup: 1, onDevice: 2 },
        { label: 'Exercices perso', inBackup: 1, onDevice: 2 },
        { label: 'Profil, niveau et réglages', inBackup: 1, onDevice: 0 },
      ]),
    );
    expect(s.snapshot()).toEqual(before);
  });

  it('restauration : exercices perso créés depuis gardés ; annulation : tout revient comme avant', async () => {
    const s = await device();
    const before = s.snapshot();
    await restoreBackup(s, backup, (j) => mergeIntoStorage(j, backup as never, 'kinetic-json'));

    expect(await s.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toHaveLength(1);
    expect(await s.get('kinetic:xp')).toEqual({ xp: 300 });
    const custom = await s.get<Array<{ id: string; name: string }>>(
      STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES,
    );
    expect(custom?.map((e) => e.id)).toEqual(['old', 'new-since-backup']);
    expect(custom?.[0]?.name).toBe('Ancien (modifié)');
    expect(await s.get('kinetic:training:session:from-backup')).not.toBeNull();
    expect(await lastRestoreUndo(s)).toMatchObject({ keys: expect.any(Number) });

    expect(await undoLastRestore(s)).toBeGreaterThan(0);
    const after = s.snapshot();
    expect(after).toEqual(before);
    expect(await lastRestoreUndo(s)).toBeNull();
  });

  it('copie de secours impossible à enregistrer (stockage plein) : restauration annulée', async () => {
    const s = await device();
    const before = s.snapshot();
    const original = s.set.bind(s);
    s.set = async (key: string, value: unknown) => {
      if (key === STORAGE_KEYS.BACKUP_RESTORE_UNDO)
        throw new DOMException('quota', 'QuotaExceededError');
      return original(key, value);
    };
    await expect(
      restoreBackup(s, backup, (j) => mergeIntoStorage(j, backup as never, 'kinetic-json')),
    ).rejects.toThrow('quota');
    expect(s.snapshot()).toEqual(before);
  });
});
