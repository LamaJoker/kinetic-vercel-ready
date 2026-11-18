/**
 * Sauvegarde automatique hebdomadaire (application native uniquement).
 *
 * Au démarrage et au retour au premier plan, au plus une fois tous les 7 jours :
 * la sauvegarde complète (export JSON v2 + lib/backup.ts) est écrite dans Documents
 * sous kinetic-sauvegarde-AAAA-MM-JJ.json ; seules les 4 dernières sont gardées.
 * Sur iPhone, ce dossier apparaît dans Fichiers › Sur mon iPhone › Kinetic : une
 * réinstallation ratée (AltStore) n'efface plus tout. Sans aucune séance, rien n'est
 * écrit (un appareil vidé ne remplace pas une bonne sauvegarde par une vide).
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import {
  STORAGE_KEYS,
  backupFileDate,
  backupFileName,
  backupFilesToPrune,
  isAutoBackupDue,
  sortBackupFiles,
} from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';
import { snapshotStorage } from './backup';
import { recordBackup } from './reminders';
import { buildJsonExport } from './training/export';
import { loadCustomExercises, loadSessions } from './training/storage';
import type { Exercise } from './training/types';

const DOCS = Directory.Documents;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Activée par défaut ; l'utilisateur peut la couper dans Profil. */
export function autoBackupEnabled(): boolean {
  return read(STORAGE_KEYS.AUTO_BACKUP_OFF) !== '1';
}

export function setAutoBackupEnabled(on: boolean): void {
  write(STORAGE_KEYS.AUTO_BACKUP_OFF, on ? null : '1');
}

export function lastAutoBackupAt(): Date | null {
  const ms = Date.parse(read(STORAGE_KEYS.AUTO_BACKUP_LAST_AT) ?? '');
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Sauvegarde complète (format d'export JSON v2), identique à l'export manuel. */
export async function buildFullBackup(storage: StoragePort): Promise<string> {
  const [sessions, exercises, custom, data] = await Promise.all([
    loadSessions(storage),
    storage.get<Exercise[]>(STORAGE_KEYS.TRAINING_EXERCISES),
    loadCustomExercises(storage),
    snapshotStorage(storage),
  ]);
  return buildJsonExport(
    Array.isArray(sessions) ? sessions : [],
    [...(Array.isArray(exercises) ? exercises : []), ...custom],
    data,
  );
}

let running = false;

/**
 * Écrit la sauvegarde si elle est due (ou si `force`). Renvoie vrai si un fichier a
 * été écrit. Sans effet sur le web ou si l'utilisateur l'a désactivée.
 */
export async function runAutoBackup(
  storage: StoragePort,
  now: Date = new Date(),
  force = false,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !autoBackupEnabled() || running) return false;
  if (!force && !isAutoBackupDue(lastAutoBackupAt()?.getTime() ?? null, now.getTime())) {
    return false;
  }
  running = true;
  try {
    // Aucune séance (appareil vidé, réinstallation) : rien à protéger, et surtout
    // pas question d'écraser ou de faire tomber une bonne sauvegarde par une vide.
    if ((await loadSessions(storage)).length === 0) return false;
    await Filesystem.writeFile({
      path: backupFileName(now),
      data: await buildFullBackup(storage),
      directory: DOCS,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    write(STORAGE_KEYS.AUTO_BACKUP_LAST_AT, now.toISOString());
    recordBackup(now); // repousse aussi le rappel de sauvegarde à 30 jours
    for (const path of backupFilesToPrune(await listBackupFiles())) {
      await Filesystem.deleteFile({ path, directory: DOCS }).catch(() => undefined);
    }
    return true;
  } catch (err) {
    console.warn('[auto-backup] failed:', err);
    return false;
  } finally {
    running = false;
  }
}

/** Fichiers de sauvegarde présents dans Documents, du plus récent au plus ancien. */
export async function listBackupFiles(): Promise<string[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    const { files } = await Filesystem.readdir({ path: '', directory: DOCS });
    return sortBackupFiles(files.map((f) => f.name));
  } catch {
    return [];
  }
}

export async function readBackupFile(name: string): Promise<string> {
  const { data } = await Filesystem.readFile({
    path: name,
    directory: DOCS,
    encoding: Encoding.UTF8,
  });
  return typeof data === 'string' ? data : await data.text();
}

/** « 18 novembre 2026 » à partir d'un nom de fichier de sauvegarde. */
export function backupFileLabel(name: string): string {
  const iso = backupFileDate(name);
  if (!iso) return name;
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
