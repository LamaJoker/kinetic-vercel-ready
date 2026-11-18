import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'ios') },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {} }));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Documents: 'DOCUMENTS' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
      fs.files.set(path, data);
      return { uri: `file:///${path}` };
    }),
    readdir: vi.fn(async () => ({ files: [...fs.files.keys()].map((name) => ({ name })) })),
    readFile: vi.fn(async ({ path }: { path: string }) => ({ data: fs.files.get(path) ?? '' })),
    deleteFile: vi.fn(async ({ path }: { path: string }) => {
      fs.files.delete(path);
    }),
  },
}));

import { Capacitor } from '@capacitor/core';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  autoBackupEnabled,
  backupFileLabel,
  lastAutoBackupAt,
  listBackupFiles,
  readBackupFile,
  runAutoBackup,
  setAutoBackupEnabled,
} from '../../apps/web/src/lib/auto-backup.js';
import { lastBackupAt } from '../../apps/web/src/lib/reminders.js';
import { parseKineticJson } from '../../apps/web/src/lib/training/import.js';
import { saveSession } from '../../apps/web/src/lib/training/storage.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const DAY = 86_400_000;

describe('sauvegarde automatique (native)', () => {
  let storage: InMemoryStorage;
  let ls: Map<string, string>;

  beforeEach(async () => {
    fs.files.clear();
    ls = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => void ls.set(k, String(v)),
      removeItem: (k: string) => void ls.delete(k),
    });
    storage = new InMemoryStorage();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await saveSession(storage, {
      id: 's1',
      name: 'Push',
      startedAt: '2026-09-30T08:00:00.000Z',
      endedAt: '2026-09-30T09:00:00.000Z',
      entries: [
        {
          exerciseId: 'bench',
          sets: [
            {
              setIndex: 0,
              weightKg: 60,
              reps: 8,
              rpe: 8,
              performedAt: '2026-09-30T08:10:00.000Z',
            },
          ],
        },
      ],
    } as WorkoutSession);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('écrit une sauvegarde complète v2 datée et met à jour les dates', async () => {
    await storage.set('kinetic:bodyweight:entries', [{ date: '2026-11-01', kg: 80 }]);
    const now = new Date(2026, 10, 18, 9);
    expect(await runAutoBackup(storage, now)).toBe(true);

    expect(await listBackupFiles()).toEqual(['kinetic-sauvegarde-2026-11-18.json']);
    const bundle = parseKineticJson(await readBackupFile('kinetic-sauvegarde-2026-11-18.json'));
    expect(bundle.data?.['kinetic:bodyweight:entries']).toEqual([{ date: '2026-11-01', kg: 80 }]);
    expect(lastAutoBackupAt()?.getTime()).toBe(now.getTime());
    // Le rappel de sauvegarde à 30 jours en tient compte.
    expect(lastBackupAt()?.getTime()).toBe(now.getTime());
  });

  it('au plus une fois tous les 7 jours, et garde les 4 dernières', async () => {
    const start = new Date(2026, 9, 1, 9).getTime();
    expect(await runAutoBackup(storage, new Date(start))).toBe(true);
    expect(await runAutoBackup(storage, new Date(start + 3 * DAY))).toBe(false);
    for (let week = 1; week <= 5; week++) {
      expect(await runAutoBackup(storage, new Date(start + week * 7 * DAY))).toBe(true);
    }
    fs.files.set('notes.txt', 'à moi');
    const files = await listBackupFiles();
    expect(files).toHaveLength(4);
    expect(files[0]).toBe('kinetic-sauvegarde-2026-11-05.json');
    expect(files.at(-1)).toBe('kinetic-sauvegarde-2026-10-15.json');
    expect(fs.files.has('notes.txt')).toBe(true);
  });

  it('ne fait rien si désactivée ou sur le web', async () => {
    expect(autoBackupEnabled()).toBe(true);
    setAutoBackupEnabled(false);
    expect(autoBackupEnabled()).toBe(false);
    expect(await runAutoBackup(storage)).toBe(false);
    setAutoBackupEnabled(true);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await runAutoBackup(storage)).toBe(false);
    expect(await listBackupFiles()).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it("n'écrit rien sur un appareil sans aucune séance (pas de sauvegarde vide)", async () => {
    const empty = new InMemoryStorage();
    expect(await runAutoBackup(empty, new Date(2026, 10, 18, 9))).toBe(false);
    expect(fs.files.size).toBe(0);
    expect(lastAutoBackupAt()).toBeNull();
  });

  it('libellé lisible à partir du nom de fichier', () => {
    expect(backupFileLabel('kinetic-sauvegarde-2026-11-18.json')).toBe('18 novembre 2026');
    expect(backupFileLabel('autre.json')).toBe('autre.json');
  });
});
