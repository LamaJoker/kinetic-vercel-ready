/**
 * Export — sérialise l'historique d'entraînement en JSON ou CSV.
 * Le fichier est déclenché via un blob + lien <a download>.
 */

import type { WorkoutSession, Exercise } from './types';

export interface ExportBundle {
  version:   1;
  exportedAt: string;           // ISO
  sessions:  readonly WorkoutSession[];
  exercises: readonly Exercise[];
}

export function buildJsonExport(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): string {
  const bundle: ExportBundle = {
    version:   1,
    exportedAt: new Date().toISOString(),
    sessions,
    exercises,
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * buildCsvExport — une ligne par série performée (format long, idéal pour tableur).
 */
export function buildCsvExport(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): string {
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const headers = [
    'session_id', 'session_name', 'started_at', 'ended_at',
    'exercise_id', 'exercise_name', 'muscles',
    'set_index', 'reps', 'weight_kg', 'rpe', 'performed_at',
  ];
  const rows: string[] = [headers.join(',')];

  for (const session of sessions) {
    for (const entry of session.entries) {
      const ex = exMap.get(entry.exerciseId);
      const exName = ex?.name ?? entry.exerciseId;
      const muscles = ex?.muscles.join('|') ?? '';
      for (const set of entry.sets) {
        rows.push([
          csvCell(session.id),
          csvCell(session.name),
          csvCell(session.startedAt),
          csvCell(session.endedAt ?? ''),
          csvCell(entry.exerciseId),
          csvCell(exName),
          csvCell(muscles),
          String(set.setIndex),
          String(set.reps),
          String(set.weightKg),
          String(set.rpe),
          csvCell(set.performedAt),
        ].join(','));
      }
    }
  }
  return rows.join('\n');
}

/**
 * downloadBlob — écrit un blob côté navigateur. No-op côté serveur / tests.
 */
export function downloadBlob(content: string, filename: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportAsJson(sessions: readonly WorkoutSession[], exercises: readonly Exercise[]): void {
  const content = buildJsonExport(sessions, exercises);
  const stamp   = new Date().toISOString().slice(0, 10);
  downloadBlob(content, `kinetic-export-${stamp}.json`, 'application/json');
}

export function exportAsCsv(sessions: readonly WorkoutSession[], exercises: readonly Exercise[]): void {
  const content = buildCsvExport(sessions, exercises);
  const stamp   = new Date().toISOString().slice(0, 10);
  downloadBlob(content, `kinetic-export-${stamp}.csv`, 'text/csv;charset=utf-8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function csvCell(value: string): string {
  if (value === '') return '';
  const needsQuote = /[",\n]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}
