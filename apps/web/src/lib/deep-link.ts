/**
 * Liens internes `com.lamajoker.kinetic://open/<page>` : widget, notifications,
 * raccourcis de l'icône (Android : res/xml/shortcuts.xml ; iPhone :
 * UIApplicationShortcutItems d'Info.plist) et app Raccourcis d'iPhone (« Ouvrir l'URL »).
 *
 * Fonctions pures, testées dans tests/unit/deep-link.test.ts. Les actions
 * elles-mêmes vivent dans lib/shortcut-actions.ts (chargé à la demande).
 */
import { STORAGE_KEYS } from '@kinetic/core';

export const DEEP_LINK_PREFIX = 'com.lamajoker.kinetic://open/';

/** Action déclenchée par un raccourci, en plus d'ouvrir la page. */
export type ShortcutAction = 'start-today' | 'log-weight' | 'add-water' | 'checkin';

/**
 * Liens des raccourcis → page ouverte et action. Titres et textes affichés :
 * lib/shortcut-list.ts (hors démarrage).
 */
export const SHORTCUT_LINKS: Readonly<
  Record<string, { route: string; action: ShortcutAction | null }>
> = {
  'seance-du-jour': { route: '/seances', action: 'start-today' },
  pesee: { route: '/bodyweight', action: 'log-weight' },
  eau: { route: '/', action: 'add-water' },
  checkin: { route: '/', action: 'checkin' },
  minuteurs: { route: '/minuteurs', action: null },
};

export interface DeepLink {
  route: string;
  action: ShortcutAction | null;
}

export function shortcutUrl(slug: string): string {
  return `${DEEP_LINK_PREFIX}${slug}`;
}

/**
 * Lien interne → page à ouvrir et action éventuelle. `null` pour tout autre
 * lien, dont le retour de connexion (com.lamajoker.kinetic://auth-callback…).
 */
export function parseDeepLink(url: string): DeepLink | null {
  if (!url.startsWith(DEEP_LINK_PREFIX)) return null;
  const page = url.slice(DEEP_LINK_PREFIX.length).split(/[?#]/)[0] ?? '';
  if (!/^[a-z][a-z-]*$/.test(page)) return { route: '/', action: null };
  const shortcut = Object.prototype.hasOwnProperty.call(SHORTCUT_LINKS, page)
    ? SHORTCUT_LINKS[page]
    : undefined;
  return shortcut ? { ...shortcut } : { route: `/${page}`, action: null };
}

/** Page visée par un lien interne (`null` si ce n'en est pas un). */
export function deepLinkRoute(url: string): string | null {
  return parseDeepLink(url)?.route ?? null;
}

/**
 * Filtre anti-doublon : au lancement à froid, le même lien peut arriver deux
 * fois (App.getLaunchUrl puis l'événement appUrlOpen) ; un verre d'eau ne doit
 * pas être compté deux fois. Renvoie vrai si le lien doit être traité.
 */
export function createDeepLinkGate(
  windowMs = 3000,
  now: () => number = Date.now,
): (url: string) => boolean {
  let last = '';
  let at = -Infinity;
  return (url) => {
    const t = now();
    if (url === last && t - at < windowMs) return false;
    last = url;
    at = t;
    return true;
  };
}

/** Mémoire de session (sessionStorage) : survit au rechargement de la page. */
export interface SessionMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Vrai la première fois qu'un lien de lancement est vu dans cette session :
 * App.getLaunchUrl() renvoie le même lien après un rechargement de la page, qui
 * ne doit pas rejouer l'action (un 2e verre d'eau, par exemple).
 */
export function firstLaunchUrl(url: string, memory: SessionMemory | null): boolean {
  try {
    if (!memory) return true;
    if (memory.getItem(STORAGE_KEYS.DEEP_LINK_LAUNCH) === url) return false;
    memory.setItem(STORAGE_KEYS.DEEP_LINK_LAUNCH, url);
  } catch {
    /* sessionStorage indisponible : on traite le lien */
  }
  return true;
}
