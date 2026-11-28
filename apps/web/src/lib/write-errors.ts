/**
 * Échec d'écriture d'une donnée de l'utilisateur : journalisé ET signalé (audit qualité
 * QA-08). Avant, ces erreurs n'allaient que dans la console : l'interface montrait une
 * valeur qui ne survivait pas au rechargement, sans un mot.
 */
import { notify } from './notify';

/** « Impossible d’enregistrer ton 1RM (stockage plein ?). Réessaie. » */
export function writeFailedMessage(what: string): string {
  return `Impossible d’enregistrer ${what} (stockage plein ?). Réessaie.`;
}

/** Affiche l'erreur à l'utilisateur (la journalisation reste à l'appelant). */
export function reportWriteFailure(what: string): void {
  if (typeof window === 'undefined') return;
  notify('error', writeFailedMessage(what));
}

/** Journalise ET affiche l'échec d'écriture. */
export function notifyWriteFailed(what: string, err: unknown): void {
  console.error(`[storage] échec d’écriture (${what}) :`, err);
  reportWriteFailure(what);
}
