/**
 * Icône de l'application (Profil › Apparence, application native seulement).
 * Pont vers le plugin natif `KineticIcon` :
 *  - Android : KineticIconPlugin.java active l'alias de lanceur de l'icône ;
 *  - iPhone : KineticIconPlugin (AppDelegate.swift) appelle setAlternateIconName.
 * Images : scripts/generate-native-assets.mjs (mêmes identifiants).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export type AppIconId = 'corail' | 'nuit' | 'minimal';

export interface AppIconChoice {
  id: AppIconId;
  label: string;
  hint: string;
}

export const DEFAULT_APP_ICON: AppIconId = 'corail';

export const APP_ICONS: readonly AppIconChoice[] = [
  { id: 'corail', label: 'Corail', hint: 'Par défaut' },
  { id: 'nuit', label: 'Nuit', hint: 'Sombre et discrète' },
  { id: 'minimal', label: 'Minimaliste', hint: 'Trait sur fond clair' },
];

export function isAppIconId(value: unknown): value is AppIconId {
  return APP_ICONS.some((i) => i.id === value);
}

/** Valeur renvoyée par le plugin → icône connue (corail sinon). */
export function normalizeAppIcon(value: unknown): AppIconId {
  return isAppIconId(value) ? value : DEFAULT_APP_ICON;
}

/** Message affiché après le changement (Android : le lanceur peut fermer l'app). */
export function appIconChangedMessage(id: AppIconId, platform: string): string {
  const label = APP_ICONS.find((i) => i.id === id)?.label ?? 'Corail';
  return platform === 'android'
    ? `Icône « ${label} » choisie. Le lanceur peut mettre quelques secondes à l’afficher.`
    : `Icône « ${label} » choisie.`;
}

interface KineticIconPlugin {
  getIcon(): Promise<{ icon?: string; supported?: boolean }>;
  setIcon(options: { icon: AppIconId }): Promise<{ icon?: string }>;
}

const KineticIcon = registerPlugin<KineticIconPlugin>('KineticIcon');

/** Icône actuelle ; `null` hors application native ou si le système ne le permet pas. */
export async function currentAppIcon(): Promise<AppIconId | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const res = await KineticIcon.getIcon();
    if (res.supported === false) return null;
    return normalizeAppIcon(res.icon);
  } catch {
    return null;
  }
}

/** Change l'icône. Lève une erreur si le système refuse. */
export async function setAppIcon(id: AppIconId): Promise<AppIconId> {
  const res = await KineticIcon.setIcon({ icon: id });
  return normalizeAppIcon(res.icon ?? id);
}
