/**
 * Feuille « Partager en image » de la page Séances (fin de séance et détail
 * d'une séance de l'historique) : état + méthodes mélangés au composant
 * `seances` (`...sessionShareSheet()`), pour garder la page elle-même presque
 * intacte. Le dessin et le partage (lib/session-share-image.ts) n'arrivent
 * qu'au premier aperçu, par import().
 */
import { STORAGE_KEYS, type ShareCardFormat, type ShareSessionInput } from '@kinetic/core';

type ShareModule = typeof import('./session-share-image');
type ShareImage = Awaited<ReturnType<ShareModule['createShareCardImage']>>;

let modulePromise: Promise<ShareModule> | null = null;
/**
 * Image prête à partager : hors de l'état Alpine (un Blob enveloppé dans un
 * proxy réactif n'est plus accepté par File ni URL.createObjectURL).
 */
let readyImage: ShareImage | null = null;
function loadShareModule(): Promise<ShareModule> {
  if (!modulePromise) {
    modulePromise = import('./session-share-image');
    modulePromise.catch(() => (modulePromise = null));
  }
  return modulePromise;
}

export interface ShareSheetState {
  sessionId: string;
  format: ShareCardFormat;
  /** URL blob: de l'aperçu ('' pendant le dessin). */
  url: string;
  busy: boolean;
  error: string;
}

/** Hôte attendu : le composant `seances`. */
export interface ShareHost {
  sessions: ShareSessionInput[];
  exerciseName(id: string): string;
  shareSheet: ShareSheetState | null;
  justSavedSessionId: string | null;
  _shareToken: number;
  _renderShareCard(): Promise<void>;
  closeShareCard(): void;
  openShareCard(id: string): void;
}

function notify(kind: 'success' | 'error' | 'info', message: string): void {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}

export function sessionShareSheet() {
  return {
    shareSheet: null as ShareSheetState | null,
    /** Séance qu'on vient d'enregistrer : carte « Séance terminée » en haut de page. */
    justSavedSessionId: null as string | null,
    _shareToken: 0,

    /** Ouvre la feuille et dessine l'aperçu (format publication par défaut). */
    openShareCard(this: ShareHost, id: string): void {
      if (!this.sessions.some((s) => s.id === id)) return;
      this.shareSheet = { sessionId: id, format: 'post', url: '', busy: false, error: '' };
      void this._renderShareCard();
    },

    shareJustSaved(this: ShareHost): void {
      if (this.justSavedSessionId) this.openShareCard(this.justSavedSessionId);
    },

    dismissJustSaved(this: ShareHost): void {
      this.justSavedSessionId = null;
    },

    /** Nom de la séance qu'on vient d'enregistrer (carte de fin). */
    justSavedName(this: ShareHost): string {
      return this.sessions.find((s) => s.id === this.justSavedSessionId)?.name ?? '';
    },

    setShareFormat(this: ShareHost, format: ShareCardFormat): void {
      if (!this.shareSheet || this.shareSheet.format === format) return;
      this.shareSheet.format = format;
      void this._renderShareCard();
    },

    shareFormatPressed(this: ShareHost, format: ShareCardFormat): string {
      return this.shareSheet?.format === format ? 'true' : 'false';
    },

    /** Classe de l'aperçu : proportions du format choisi. */
    sharePreviewClass(this: ShareHost): string {
      return this.shareSheet?.format === 'story' ? 'aspect-[9/16] w-[46%]' : 'aspect-[4/5] w-[72%]';
    },

    async _renderShareCard(this: ShareHost): Promise<void> {
      const sheet = this.shareSheet;
      if (!sheet) return;
      const token = ++this._shareToken;
      const session = this.sessions.find((s) => s.id === sheet.sessionId);
      if (!session) return;
      if (sheet.url) URL.revokeObjectURL(sheet.url);
      sheet.url = '';
      sheet.error = '';
      readyImage = null;
      try {
        const mod = await loadShareModule();
        const image = await mod.createShareCardImage(
          session,
          this.sessions,
          (exId) => this.exerciseName(exId),
          sheet.format,
        );
        if (token !== this._shareToken || this.shareSheet !== sheet) return;
        readyImage = image;
        sheet.url = URL.createObjectURL(image.blob);
      } catch (err) {
        console.warn('[seances] share card failed:', err);
        if (token === this._shareToken && this.shareSheet === sheet) {
          sheet.error = "Impossible de créer l'image. Réessaie.";
        }
      }
    },

    async confirmShareCard(this: ShareHost): Promise<void> {
      const sheet = this.shareSheet;
      const image = readyImage;
      if (!sheet || !image || sheet.busy) return;
      sheet.busy = true;
      try {
        const mod = await loadShareModule();
        const outcome = await mod.shareCardImage(image);
        if (outcome === 'downloaded') notify('success', 'Image enregistrée.');
        if (outcome !== 'cancelled') this.closeShareCard();
      } catch (err) {
        console.warn('[seances] share failed:', err);
        notify('error', 'Partage impossible. Réessaie.');
      } finally {
        if (this.shareSheet === sheet) sheet.busy = false;
      }
    },

    closeShareCard(this: ShareHost): void {
      this._shareToken++;
      if (this.shareSheet?.url) URL.revokeObjectURL(this.shareSheet.url);
      this.shareSheet = null;
      readyImage = null;
    },
  };
}
