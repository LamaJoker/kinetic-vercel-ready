import { STORAGE_KEYS } from '@kinetic/core';

/** Modèle à ouvrir dans l'éditeur (sessionStorage : survit au rechargement de /modele). */
export function readEditedTemplateId(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEYS.TEMPLATE_EDITOR_ID) ?? '';
  } catch {
    return '';
  }
}

/** Ouvre l'éditeur (/modele) sur un modèle existant, ou sur un modèle vide sans `id`. */
export function openTemplateEditor(id?: string): void {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEYS.TEMPLATE_EDITOR_ID, id);
    else sessionStorage.removeItem(STORAGE_KEYS.TEMPLATE_EDITOR_ID);
  } catch {
    /* mode privé : l'éditeur s'ouvrira sur un modèle vide */
  }
  // Import différé : la page Séances reste importable sans le routeur (tests).
  void import('../../router').then(({ navigate }) => navigate('/modele'));
}
