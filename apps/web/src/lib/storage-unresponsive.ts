/**
 * Stockage de l'appareil bloqué (IndexedDB de WebKit qui ne répond plus, sync.md § 4.11).
 *
 * Les données ne sont PAS perdues : seule la lecture est impossible. Reprise :
 *  1. premier blocage → rechargement de la page, UNE fois (marqueur horodaté en
 *     sessionStorage : pas de boucle) ;
 *  2. nouveau blocage peu après ce rechargement (ou sessionStorage indisponible) →
 *     message clair et persistant avec « Réessayer ». Jamais d'écran vide présenté comme
 *     normal, jamais de valeurs par défaut écrites à la place des données.
 */
import { STORAGE_KEYS } from '@kinetic/core';

export const STORAGE_UNRESPONSIVE_MESSAGE =
  "Le stockage de l'appareil ne répond pas. Tes données ne sont pas perdues : ferme complètement l'app puis rouvre-la.";

/** Un blocage dans cette fenêtre après un rechargement automatique → message, pas de 2e rechargement. */
export const RELOAD_WINDOW_MS = 5 * 60_000;

export interface StorageRecoveryEnv {
  now(): number;
  /** sessionStorage (ou `null` s'il est indisponible). */
  session(): Pick<Storage, 'getItem' | 'setItem'> | null;
  reload(): void;
  showMessage(retry: () => void): void;
}

export type RecoveryAction = 'reload' | 'message' | 'already-handled';

const MARK = STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT;

/** Gestionnaire du blocage pour CE chargement de page (une seule action, idempotent). */
export function createStorageRecovery(env: StorageRecoveryEnv): () => RecoveryAction {
  let handled = false;
  const mark = (): boolean => {
    try {
      const s = env.session();
      if (!s) return false;
      s.setItem(MARK, String(env.now()));
      return true;
    } catch {
      return false;
    }
  };
  const recentlyReloaded = (): boolean | null => {
    try {
      const s = env.session();
      if (!s) return null;
      const last = Number(s.getItem(MARK) ?? NaN);
      const age = env.now() - last;
      return Number.isFinite(last) && age >= 0 && age < RELOAD_WINDOW_MS;
    } catch {
      return null;
    }
  };
  const retry = (): void => {
    mark();
    env.reload();
  };
  return () => {
    if (handled) return 'already-handled';
    handled = true;
    // Sans sessionStorage, impossible de garantir l'absence de boucle : message direct.
    if (recentlyReloaded() !== false || !mark()) {
      env.showMessage(retry);
      return 'message';
    }
    env.reload();
    return 'reload';
  };
}

/** Message persistant (au-dessus de tout, non masquable) avec le bouton « Réessayer ». */
export function showStorageUnresponsiveMessage(retry: () => void): void {
  if (typeof document === 'undefined' || document.getElementById('k-storage-stuck')) return;
  const box = document.createElement('div');
  box.id = 'k-storage-stuck';
  box.className = 'k-storage-stuck';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'k-storage-stuck-text');
  const text = document.createElement('p');
  text.id = 'k-storage-stuck-text';
  text.textContent = STORAGE_UNRESPONSIVE_MESSAGE;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Réessayer';
  button.addEventListener('click', retry);
  box.append(text, button);
  document.body.append(box);
  button.focus();
}

/** Gestionnaire de l'app (navigateur réel). */
export const handleStorageUnresponsive = createStorageRecovery({
  now: () => Date.now(),
  session: () => (typeof sessionStorage === 'undefined' ? null : sessionStorage),
  reload: () => window.location.reload(),
  showMessage: showStorageUnresponsiveMessage,
});
