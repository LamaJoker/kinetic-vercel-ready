/**
 * Auto Backup Domain — règles de la sauvegarde automatique hebdomadaire (app native).
 *
 * Un fichier daté par sauvegarde (kinetic-sauvegarde-AAAA-MM-JJ.json, même nom que
 * l'export manuel), au plus une fois tous les 7 jours, et seulement les plus récents
 * gardés.
 *
 * Pur — aucune dépendance externe, aucun I/O.
 */

export const AUTO_BACKUP_INTERVAL_DAYS = 7;
export const AUTO_BACKUP_KEEP = 4;

const DAY_MS = 24 * 60 * 60 * 1_000;
const BACKUP_NAME_RE = /^kinetic-sauvegarde-(\d{4}-\d{2}-\d{2})\.json$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Nom du fichier de sauvegarde du jour (date locale). */
export function backupFileName(at: Date): string {
  return `kinetic-sauvegarde-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}

/** Date (AAAA-MM-JJ) d'un fichier de sauvegarde Kinetic, null pour tout autre fichier. */
export function backupFileDate(name: string): string | null {
  return BACKUP_NAME_RE.exec(name)?.[1] ?? null;
}

/** Vrai si la dernière sauvegarde automatique date d'au moins 7 jours (ou n'existe pas). */
export function isAutoBackupDue(lastMs: number | null, nowMs: number): boolean {
  if (lastMs === null || !Number.isFinite(lastMs)) return true;
  // Horloge revenue en arrière (date changée à la main) : on ne reste pas bloqué.
  if (lastMs > nowMs + DAY_MS) return true;
  return nowMs - lastMs >= AUTO_BACKUP_INTERVAL_DAYS * DAY_MS;
}

/** Fichiers de sauvegarde Kinetic seulement, du plus récent au plus ancien. */
export function sortBackupFiles(names: readonly string[]): string[] {
  return names
    .filter((n) => backupFileDate(n) !== null)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Sauvegardes à supprimer pour n'en garder que `keep` (les plus récentes). */
export function backupFilesToPrune(names: readonly string[], keep = AUTO_BACKUP_KEEP): string[] {
  return sortBackupFiles(names).slice(Math.max(0, keep));
}
