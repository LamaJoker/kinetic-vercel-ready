/**
 * Profil, application native : section « Raccourcis » (liens à coller dans
 * l'app Raccourcis d'iPhone) et choix de l'icône de l'application (Apparence).
 * Logique : lib/deep-link.ts et lib/app-icon.ts.
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';
import { SHORTCUTS, type ShortcutDef } from '../lib/shortcut-list';
import {
  APP_ICONS,
  appIconChangedMessage,
  currentAppIcon,
  isAppIconId,
  setAppIcon,
  type AppIconId,
} from '../lib/app-icon';
import { hapticLight, hapticSuccess } from '../lib/haptics';

function notify(kind: 'success' | 'info' | 'error', message: string): void {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
}

/** Copie un texte (API presse-papiers, sinon sélection d'un champ temporaire). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type ShortcutItem = ShortcutDef;

export function appShortcuts() {
  return {
    items: SHORTCUTS,
    copied: '',
    android: Capacitor.getPlatform() === 'android',
    _timer: 0,

    copyLabel(item: ShortcutItem): string {
      return this.copied === item.slug ? 'Copié' : 'Copier';
    },
    copyAria(item: ShortcutItem): string {
      return `Copier le lien « ${item.title} »`;
    },

    async copy(item: ShortcutItem): Promise<void> {
      if (!(await copyText(item.url))) {
        notify('error', `Copie impossible. Lien : ${item.url}`);
        return;
      }
      hapticLight();
      this.copied = item.slug;
      window.clearTimeout(this._timer);
      this._timer = window.setTimeout(() => {
        this.copied = '';
      }, 2000);
      notify('success', 'Lien copié : colle-le dans l’action « Ouvrir l’URL ».');
    },
  };
}

export function appIconPicker() {
  return {
    icons: APP_ICONS,
    /** null : choix indisponible (web, ou système qui ne le permet pas). */
    current: null as AppIconId | null,
    busy: false,
    android: Capacitor.getPlatform() === 'android',

    async init(): Promise<void> {
      this.current = await currentAppIcon();
    },

    get available(): boolean {
      return this.current !== null;
    },
    pressed(id: string): string {
      return this.current === id ? 'true' : 'false';
    },

    async choose(id: string): Promise<void> {
      if (!isAppIconId(id) || this.busy || this.current === id) return;
      this.busy = true;
      try {
        this.current = await setAppIcon(id);
        hapticSuccess();
        notify('success', appIconChangedMessage(this.current, Capacitor.getPlatform()));
      } catch (err) {
        console.warn('[icône] changement impossible :', err);
        notify('error', 'Impossible de changer l’icône.');
      } finally {
        this.busy = false;
      }
    },
  };
}
