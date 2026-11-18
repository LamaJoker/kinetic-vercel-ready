import { describe, it, expect } from 'vitest';
import {
  backupFileDate,
  backupFileName,
  backupFilesToPrune,
  isAutoBackupDue,
  sortBackupFiles,
} from '@kinetic/core';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 18, 9, 30).getTime();

describe('sauvegarde automatique', () => {
  it('nomme le fichier avec la date locale', () => {
    expect(backupFileName(new Date(2026, 0, 5, 23, 59))).toBe('kinetic-sauvegarde-2026-01-05.json');
  });

  it('reconnaît uniquement les fichiers de sauvegarde Kinetic', () => {
    expect(backupFileDate('kinetic-sauvegarde-2026-11-18.json')).toBe('2026-11-18');
    expect(backupFileDate('kinetic-export-2026-11-18.json')).toBeNull();
    expect(backupFileDate('kinetic-sauvegarde-2026-11-18.json.tmp')).toBeNull();
    expect(backupFileDate('photo.jpg')).toBeNull();
  });

  it('est due sans sauvegarde, ou après 7 jours', () => {
    expect(isAutoBackupDue(null, NOW)).toBe(true);
    expect(isAutoBackupDue(NOW - 6 * DAY, NOW)).toBe(false);
    expect(isAutoBackupDue(NOW - 7 * DAY, NOW)).toBe(true);
    expect(isAutoBackupDue(NOW - 30 * DAY, NOW)).toBe(true);
  });

  it("n'est pas bloquée par une horloge revenue en arrière", () => {
    expect(isAutoBackupDue(NOW + 3 * DAY, NOW)).toBe(true);
    expect(isAutoBackupDue(NOW + 60_000, NOW)).toBe(false);
  });

  it('trie du plus récent au plus ancien et garde les 4 dernières', () => {
    const files = [
      'kinetic-sauvegarde-2026-10-21.json',
      'notes.txt',
      'kinetic-sauvegarde-2026-11-18.json',
      'kinetic-sauvegarde-2026-10-28.json',
      'kinetic-export-2026-11-01.csv',
      'kinetic-sauvegarde-2026-11-11.json',
      'kinetic-sauvegarde-2026-11-04.json',
      'kinetic-sauvegarde-2025-12-30.json',
    ];
    expect(sortBackupFiles(files)[0]).toBe('kinetic-sauvegarde-2026-11-18.json');
    expect(backupFilesToPrune(files)).toEqual([
      'kinetic-sauvegarde-2026-10-21.json',
      'kinetic-sauvegarde-2025-12-30.json',
    ]);
    expect(backupFilesToPrune(files.slice(0, 3))).toEqual([]);
  });
});
