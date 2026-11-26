/**
 * Sauvegarde complète : copie de toutes les données de l'application (poids,
 * mensurations, nutrition, routine, niveau, programme…) jointe à l'export JSON,
 * et restauration depuis ce fichier. Les séances et exercices suivent leur propre
 * fusion (import.ts) ; les clés propres à cet appareil ne sont ni copiées ni restaurées.
 *
 * Restauration (audit stockage local F5) : aperçu de ce qui sera remplacé, confirmation
 * explicite dans l'UI, puis écriture à travers un journal (lib/write-journal.ts) dont les
 * valeurs d'avant sont gardées sur l'appareil : « Annuler la restauration » remet
 * exactement les clés modifiées dans leur état d'avant.
 */
import { STORAGE_KEYS } from '@kinetic/core';
import type { StoragePort } from '@kinetic/core';
import { LOCAL_SCHEMA_VERSION } from './schema-version';
import { journalWrites, undoJournal, type JournalEntry } from './write-journal';

const SKIP_KEYS = new Set<string>([
  STORAGE_KEYS.SYNC_LAST_AT,
  STORAGE_KEYS.SYNC_CURSOR,
  STORAGE_KEYS.SYNC_OUTBOX,
  STORAGE_KEYS.TRAINING_SESSIONS,
  STORAGE_KEYS.TRAINING_EXERCISES,
  STORAGE_KEYS.TRAINING_CATALOG_VERSION,
  STORAGE_KEYS.DEVICE_ID,
  STORAGE_KEYS.DEMO_MANIFEST,
  STORAGE_KEYS.TRAINING_ACTIVE_SESSION,
  // État propre à l'appareil (audit F6) : restaurer une ancienne version de schéma ferait
  // rejouer une migration sur des données déjà migrées ; une mutation de tâche en attente
  // serait rejouée (XP en double).
  STORAGE_KEYS.SCHEMA_VERSION,
  STORAGE_KEYS.SCHEMA_MIGRATION_LOCK,
  STORAGE_KEYS.PENDING_TASK_MUTATION,
  STORAGE_KEYS.SYNC_MIGRATED_TO,
  STORAGE_KEYS.SYNC_FALLBACK_JOURNAL,
  STORAGE_KEYS.BACKUP_RESTORE_UNDO,
]);

export function isBackedUpKey(key: string): boolean {
  return (
    key.startsWith('kinetic:') &&
    !SKIP_KEYS.has(key) &&
    !key.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX)
  );
}

export async function snapshotStorage(storage: StoragePort): Promise<Record<string, unknown>> {
  const keys = (await storage.keys()).filter(isBackedUpKey).sort();
  const values = await Promise.all(keys.map((key) => storage.get<unknown>(key)));
  const data: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    if (values[i] !== null && values[i] !== undefined) data[key] = values[i];
  });
  return data;
}

function idOf(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * Exercices perso : union par identifiant (ceux de la sauvegarde d'abord). Un exercice
 * créé depuis la sauvegarde est gardé : les séances qui l'utilisent ne pointent jamais
 * vers un exercice inconnu.
 */
function unionById(backup: unknown, current: unknown): unknown {
  if (!Array.isArray(backup) || !Array.isArray(current)) return backup;
  const ids = new Set(backup.map(idOf).filter((id): id is string => id !== null));
  const kept = current.filter((item) => {
    const id = idOf(item);
    return id !== null && !ids.has(id);
  });
  return [...backup, ...kept];
}

/** Écrit les données d'une sauvegarde (remplace les valeurs existantes). Renvoie le nombre de clés. */
export async function restoreStorage(
  storage: StoragePort,
  data: Readonly<Record<string, unknown>>,
): Promise<number> {
  const entries = Object.entries(data).filter(
    ([key, value]) => isBackedUpKey(key) && value !== null && value !== undefined,
  );
  for (const [key, value] of entries) {
    const next =
      key === STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES
        ? unionById(value, await storage.get<unknown>(key))
        : value;
    await storage.set(key, next);
  }
  return entries.length;
}

// ─── Aperçu avant restauration ────────────────────────────────────────────

/** Contenu minimal d'une sauvegarde lue (cf. `parseKineticJson`). */
export interface BackupBundle {
  sessions: readonly unknown[];
  data?: Record<string, unknown>;
  exportedAt?: string;
  schemaVersion?: number;
}

export interface BackupPreviewLine {
  label: string;
  inBackup: number;
  onDevice: number;
}

export interface BackupPreview {
  /** Date de la sauvegarde (ISO), si connue. */
  exportedAt: string | null;
  sessions: number;
  /** Données remplacées, par catégorie (pesées, mensurations…). */
  lines: BackupPreviewLine[];
  /** Nombre de données de la sauvegarde (clés). */
  keys: number;
  /** Sauvegarde faite par une version plus récente de l'app : restauration refusée. */
  tooNew: boolean;
}

/** Préfixe des journaux de nutrition (`kinetic:nutrition:log:<date>`). */
const NUTRITION_LOG_PREFIX = STORAGE_KEYS.NUTRITION_LOG('');

const CATEGORIES: ReadonlyArray<{ label: string; match: (key: string) => boolean }> = [
  { label: 'Pesées', match: (k) => k === STORAGE_KEYS.BODYWEIGHT_ENTRIES },
  { label: 'Mensurations', match: (k) => k === STORAGE_KEYS.MEASUREMENTS_ENTRIES },
  { label: 'Modèles de séance', match: (k) => k === STORAGE_KEYS.TRAINING_TEMPLATES },
  { label: 'Exercices perso', match: (k) => k === STORAGE_KEYS.TRAINING_CUSTOM_EXERCISES },
  { label: 'Jours de nutrition', match: (k) => k.startsWith(NUTRITION_LOG_PREFIX) },
];

function countOf(key: string, value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (key.startsWith(NUTRITION_LOG_PREFIX)) return 1;
  return Array.isArray(value) ? value.length : 1;
}

export function isBackupTooNew(bundle: Pick<BackupBundle, 'schemaVersion'>): boolean {
  return typeof bundle.schemaVersion === 'number' && bundle.schemaVersion > LOCAL_SCHEMA_VERSION;
}

/** Ce que la restauration remplacera, comparé à ce qui est sur l'appareil. */
export async function previewRestore(
  storage: StoragePort,
  bundle: BackupBundle,
): Promise<BackupPreview> {
  const data = Object.entries(bundle.data ?? {}).filter(
    ([key, value]) => isBackedUpKey(key) && value !== null && value !== undefined,
  );
  const deviceKeys = (await storage.keys()).filter(isBackedUpKey);
  const lines: BackupPreviewLine[] = [];
  for (const cat of CATEGORIES) {
    let inBackup = 0;
    for (const [key, value] of data) if (cat.match(key)) inBackup += countOf(key, value);
    let onDevice = 0;
    for (const key of deviceKeys) {
      if (cat.match(key)) onDevice += countOf(key, await storage.get<unknown>(key));
    }
    if (inBackup > 0 || onDevice > 0) lines.push({ label: cat.label, inBackup, onDevice });
  }
  const others = data.filter(([key]) => !CATEGORIES.some((c) => c.match(key))).length;
  if (others > 0)
    lines.push({ label: 'Profil, niveau et réglages', inBackup: others, onDevice: 0 });
  return {
    exportedAt: bundle.exportedAt ?? null,
    sessions: bundle.sessions.length,
    lines,
    keys: data.length,
    tooNew: isBackupTooNew(bundle),
  };
}

// ─── Restauration annulable ───────────────────────────────────────────────

interface RestoreUndo {
  at: string;
  entries: JournalEntry[];
}

function readUndo(raw: unknown): RestoreUndo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { at?: unknown; entries?: unknown };
  if (typeof r.at !== 'string' || !Array.isArray(r.entries)) return null;
  const entries = r.entries.filter(
    (e): e is JournalEntry =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as JournalEntry).key === 'string' &&
      typeof (e as JournalEntry).existed === 'boolean',
  );
  return { at: r.at, entries };
}

/**
 * Restaure une sauvegarde complète (données + séances via `mergeSessions`) en gardant
 * de quoi l'annuler. Refuse une sauvegarde d'une version plus récente. Si la copie de
 * secours ne peut pas être enregistrée (stockage plein), la restauration est annulée :
 * jamais de remplacement sans retour possible. Renvoie le nombre de clés restaurées.
 */
export async function restoreBackup(
  storage: StoragePort,
  bundle: BackupBundle,
  mergeSessions: (journaled: StoragePort) => Promise<unknown>,
  now: Date = new Date(),
): Promise<number> {
  if (isBackupTooNew(bundle)) {
    throw new Error(
      'Cette sauvegarde vient d’une version plus récente de Kinetic : mets l’app à jour pour la restaurer.',
    );
  }
  const journal = journalWrites(storage);
  let count = 0;
  try {
    count = await restoreStorage(journal.storage, bundle.data ?? {});
    if (bundle.sessions.length > 0) await mergeSessions(journal.storage);
    const undo: RestoreUndo = { at: now.toISOString(), entries: journal.entries() };
    await storage.set(STORAGE_KEYS.BACKUP_RESTORE_UNDO, undo);
  } catch (err) {
    await undoJournal(storage, journal.entries());
    throw err;
  }
  return count;
}

/** Dernière restauration annulable sur cet appareil (date ISO), ou null. */
export async function lastRestoreUndo(
  storage: StoragePort,
): Promise<{ at: string; keys: number } | null> {
  const undo = readUndo(await storage.get<unknown>(STORAGE_KEYS.BACKUP_RESTORE_UNDO));
  return undo ? { at: undo.at, keys: undo.entries.length } : null;
}

/**
 * Remet les données modifiées par la dernière restauration dans leur état d'avant
 * (séances ajoutées retirées, valeurs remplacées remises). Renvoie le nombre de clés.
 */
export async function undoLastRestore(storage: StoragePort): Promise<number> {
  const undo = readUndo(await storage.get<unknown>(STORAGE_KEYS.BACKUP_RESTORE_UNDO));
  if (!undo) return 0;
  await undoJournal(storage, undo.entries);
  await storage.remove(STORAGE_KEYS.BACKUP_RESTORE_UNDO);
  return undo.entries.length;
}

/** Oublie la possibilité d'annuler (libère la place de la copie de secours). */
export async function forgetRestoreUndo(storage: StoragePort): Promise<void> {
  await storage.remove(STORAGE_KEYS.BACKUP_RESTORE_UNDO);
}
