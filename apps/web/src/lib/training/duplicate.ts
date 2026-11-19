/**
 * Dupliquer une séance passée ou un modèle (menu contextuel de Séances).
 * Logique pure : les identifiants et la date sont fournis par l'appelant.
 */
import { normalizeSupersets } from '@kinetic/core';
import type { WorkoutSession, WorkoutTemplate } from './types';

/**
 * Nouvelle séance en cours reprenant les exercices (et supersets) d'une séance
 * passée, séries vides : on les refait en direct.
 */
export function sessionFromPast(past: WorkoutSession, id: string, now: string): WorkoutSession {
  return {
    id,
    name: past.name,
    ...(past.templateId ? { templateId: past.templateId } : {}),
    startedAt: now,
    entries: normalizeSupersets(
      past.entries.map((e) => ({
        exerciseId: e.exerciseId,
        sets: [],
        ...(e.group ? { group: e.group } : {}),
      })),
    ),
  };
}

/** Copie d'un modèle, nommée « … (copie) », placée juste après l'original. */
export function withDuplicatedTemplate(
  list: readonly WorkoutTemplate[],
  templateId: string,
  id: string,
  now: string,
): WorkoutTemplate[] {
  const i = list.findIndex((t) => t.id === templateId);
  if (i < 0) return [...list];
  const src = list[i]!;
  const copy: WorkoutTemplate = {
    id,
    name: `${src.name} (copie)`,
    createdAt: now,
    exercises: src.exercises.map((ex) => ({ ...ex })),
  };
  return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
}
