/**
 * Export « Bilan PDF » (Profil › Données, page Bilan) — chargé à la demande
 * (import()) : lit les données, compose le PDF (@kinetic/core
 * progress-report.domain, générateur sans dépendance) puis le télécharge sur
 * le web ou l'écrit dans Documents et ouvre la feuille de partage en natif.
 */
import {
  STORAGE_KEYS,
  normalizeGoals,
  progressReportFileName,
  progressReportPdf,
  type ReportBodyweight,
  type ReportMeasurement,
  type ReportPeriodKey,
  type StoragePort,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadExercises, loadSessions } from './training/storage';
import { downloadOrShare } from './training/export';

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Compose le PDF du bilan (chaîne ASCII) à partir du stockage. */
export async function buildProgressPdf(
  storage: StoragePort,
  period: ReportPeriodKey,
  now = Date.now(),
): Promise<string> {
  const [sessions, exercises, bodyweight, measurements, goals, profile] = await Promise.all([
    loadSessions(storage),
    loadExercises(storage),
    storage.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
    storage.get(STORAGE_KEYS.MEASUREMENTS_ENTRIES),
    storage.get(STORAGE_KEYS.STRENGTH_GOALS),
    storage.get<{ displayName?: string }>(STORAGE_KEYS.PROFILE),
  ]);
  const byId = new Map(exercises.map((e) => [e.id, e]));
  return progressReportPdf(
    {
      name: typeof profile?.displayName === 'string' ? profile.displayName : '',
      period,
      sessions,
      exerciseName: (id) => byId.get(id)?.name ?? id,
      musclesOf: (id) => byId.get(id)?.muscles ?? [],
      bodyweight: list<ReportBodyweight>(bodyweight),
      measurements: list<ReportMeasurement>(measurements),
      goals: normalizeGoals(goals),
    },
    now,
  );
}

/**
 * Exporte le bilan de la période choisie. Réutilisable (Profil, page Bilan).
 * Le PDF est entièrement ASCII : écrit tel quel (UTF-8 = mêmes octets).
 */
export async function exportProgressPdf(period: ReportPeriodKey): Promise<void> {
  const deps = await getDeps();
  const now = Date.now();
  const pdf = await buildProgressPdf(deps.storage, period, now);
  await downloadOrShare(pdf, progressReportFileName(now), 'application/pdf');
}
