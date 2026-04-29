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
 * Conforme RFC 4180 :
 *  - BOM UTF-8 pour Excel (évite les problèmes d'encodage accents/emojis)
 *  - Fins de ligne CRLF
 *  - Toutes les cellules texte entre guillemets doubles
 */
export function buildCsvExport(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): string {
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const headers = [
    'session_id', 'session_name', 'started_at', 'ended_at',
    'exercise_id', 'exercise_name', 'muscles',
    'set_index', 'reps', 'weight_kg', 'rpe', 'e1rm_kg', 'performed_at',
  ];

  const CRLF = '\r\n';
  // BOM UTF-8 pour compatibilité Excel Windows
  const BOM = '﻿';
  const rows: string[] = [headers.map(h => `"${h}"`).join(',')];

  for (const session of sessions) {
    for (const entry of session.entries) {
      const ex     = exMap.get(entry.exerciseId);
      const exName = ex?.name ?? entry.exerciseId;
      const muscles = (ex?.muscles ?? []).join(';');
      for (const set of entry.sets) {
        const e1rm = (set.weightKg * (1 + set.reps / 30)).toFixed(1);
        rows.push([
          csvCell(session.id),
          csvCell(session.name),
          csvCell(session.startedAt),
          csvCell(session.endedAt ?? ''),
          csvCell(entry.exerciseId),
          csvCell(exName),
          csvCell(muscles),
          String(set.setIndex + 1),
          String(set.reps),
          String(set.weightKg),
          String(set.rpe),
          e1rm,
          csvCell(set.performedAt),
        ].join(','));
      }
    }
  }
  return BOM + rows.join(CRLF) + CRLF;
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
  downloadBlob(content, `kinetic-export-${stamp}.csv`, 'text/csv;charset=utf-8;');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Toujours entre guillemets (RFC 4180 — plus sûr pour Excel/Sheets). */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
