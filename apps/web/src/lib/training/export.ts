/**
 * Export — sérialise l'historique d'entraînement en JSON ou CSV.
 *
 * Sur le web : déclenche un téléchargement classique via blob + lien `<a download>`.
 * Sur Capacitor (Android/iOS) : écrit le fichier dans Documents puis ouvre la
 * feuille de partage native (le `<a download>` ne fonctionne pas en WebView).
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { STORAGE_KEYS } from '@kinetic/core';
import type { WorkoutSession, Exercise } from './types';

export interface ExportBundle {
  version: 1;
  exportedAt: string; // ISO
  sessions: readonly WorkoutSession[];
  exercises: readonly Exercise[];
}

export function buildJsonExport(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): string {
  const bundle: ExportBundle = {
    version: 1,
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
    'session_id',
    'session_name',
    'started_at',
    'ended_at',
    'exercise_id',
    'exercise_name',
    'muscles',
    'set_index',
    'reps',
    'weight_kg',
    'rpe',
    'e1rm_kg',
    'performed_at',
  ];

  const CRLF = '\r\n';
  // BOM UTF-8 pour compatibilité Excel Windows
  const BOM = '﻿';
  const rows: string[] = [headers.map((h) => `"${h}"`).join(',')];

  for (const session of sessions) {
    for (const entry of session.entries) {
      const ex = exMap.get(entry.exerciseId);
      const exName = ex?.name ?? entry.exerciseId;
      const muscles = (ex?.muscles ?? []).join(';');
      for (const set of entry.sets) {
        const e1rm = (set.weightKg * (1 + set.reps / 30)).toFixed(1);
        rows.push(
          [
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
          ].join(','),
        );
      }
    }
  }
  return BOM + rows.join(CRLF) + CRLF;
}

/**
 * downloadOrShare — écrit le fichier de la bonne façon selon la plateforme.
 *
 *  - Web    : Blob + <a download>
 *  - Native : Filesystem.writeFile (Documents) + Share.share()
 *
 * Sur Android, certaines versions de WebView refusent silencieusement le
 * `<a download>` ou produisent un fichier inaccessible — d'où le fallback
 * natif obligatoire.
 */
export async function downloadOrShare(
  content: string,
  filename: string,
  mime: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await downloadNative(content, filename, mime);
  } else {
    downloadWeb(content, filename, mime);
  }
}

async function downloadNative(content: string, filename: string, _mime: string): Promise<void> {
  // Écrit dans Documents/ — accessible par tous les explorateurs de fichiers
  // Android. UTF-8 pour préserver le BOM CSV et les accents.
  const result = await Filesystem.writeFile({
    path: filename,
    data: content,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  // Tente d'ouvrir la feuille de partage native (l'utilisateur peut alors
  // sauvegarder vers Drive, mail, etc.). Pas bloquant si échec.
  try {
    await Share.share({
      title: 'Export Kinetic',
      text: `Export de tes données : ${filename}`,
      url: result.uri,
      dialogTitle: 'Sauvegarder ton export',
    });
  } catch {
    // L'utilisateur a annulé OU le partage n'est pas dispo.
    // Le fichier est déjà écrit dans Documents/, on l'informe juste.
    console.info('[export] Share cancelled or unavailable, file saved at:', result.uri);
    notify('success', `Fichier sauvegardé dans Documents/${filename}`);
    return;
  }
  notify('success', `Export prêt : ${filename}`);
}

function downloadWeb(content: string, filename: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Compatibilité descendante — anciens appels. */
export function downloadBlob(content: string, filename: string, mime: string): void {
  void downloadOrShare(content, filename, mime);
}

export async function exportAsJson(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): Promise<void> {
  const content = buildJsonExport(sessions, exercises);
  const stamp = new Date().toISOString().slice(0, 10);
  await downloadOrShare(content, `kinetic-export-${stamp}.json`, 'application/json');
}

export async function exportAsCsv(
  sessions: readonly WorkoutSession[],
  exercises: readonly Exercise[],
): Promise<void> {
  const content = buildCsvExport(sessions, exercises);
  const stamp = new Date().toISOString().slice(0, 10);
  await downloadOrShare(content, `kinetic-export-${stamp}.csv`, 'text/csv;charset=utf-8;');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Toujours entre guillemets (RFC 4180 — plus sûr pour Excel/Sheets). */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function notify(kind: 'success' | 'error' | 'info', message: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}
