/**
 * Mouvement entre écrans, façon iOS (logique pure + état partagé du routeur).
 *
 * Le routeur (router.ts) choisit un « sens » pour chaque navigation et le pose
 * sur <html data-k-nav="…"> pendant une View Transition ; native-feel.css
 * l'anime :
 *   forward : l'écran suivant glisse depuis la droite par-dessus le précédent,
 *             qui recule d'un tiers (parallaxe) et s'estompe légèrement ;
 *   back    : mouvement inverse ;
 *   tab     : simple fondu court (changement d'onglet, comme iOS) ;
 *   swipe   : après le geste « retour » (native-gestures.ts) : l'écran courant
 *             est déjà sorti sous le doigt, seul le précédent revient en place ;
 *   none    : pas d'animation (premier rendu, redirection).
 * Le sens avant / arrière d'un popstate est déduit d'un index rangé dans
 * history.state (kIdx), incrémenté à chaque pushState du routeur.
 */

export type NavDirection = 'forward' | 'back' | 'tab' | 'swipe' | 'none';
export type NavKind = 'push' | 'replace' | 'pop' | 'initial';

/** Écrans racines : un par onglet de la barre (Corps = poids + mensurations). */
export const ROOT_TABS: readonly string[] = [
  '/',
  '/seances',
  '/bodyweight',
  '/mensurations',
  '/vitalite',
  '/profile',
];

/** Écrans plein cadre : on les enchaîne en fondu, jamais en glissé. */
const FULLSCREEN: readonly string[] = ['/onboarding', '/login', '/auth-callback', '/auth/callback'];

export function isRootTab(path: string): boolean {
  return ROOT_TABS.includes(normalize(path));
}

function normalize(path: string): string {
  const p = (path || '/').split('?')[0]!.split('#')[0]!;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Sens d'animation d'une navigation de `from` vers `to`.
 * `fromIdx` / `toIdx` : index d'historique (history.state.kIdx), utiles au popstate.
 */
export function navDirection(
  from: string,
  to: string,
  kind: NavKind,
  fromIdx?: number | null,
  toIdx?: number | null,
): NavDirection {
  const a = normalize(from);
  const b = normalize(to);
  if (kind === 'initial' || a === b) return 'none';
  if (FULLSCREEN.includes(a) || FULLSCREEN.includes(b)) return 'tab';
  if (isRootTab(a) && isRootTab(b)) return 'tab';
  if (kind === 'replace') return 'tab';
  if (kind === 'pop') {
    if (typeof fromIdx !== 'number' || typeof toIdx !== 'number' || fromIdx === toIdx) {
      return 'tab';
    }
    return toIdx < fromIdx ? 'back' : 'forward';
  }
  // push : vers un onglet racine (appui dans la barre) = changement d'onglet.
  return isRootTab(b) ? 'tab' : 'forward';
}

// ─── État partagé routeur ↔ gestes ─────────────────────────────────────────

let historyIdx = 0;
let forcedNext: NavDirection | null = null;

/** Index de l'entrée d'historique courante (0 = première page de la session). */
export function currentHistoryIdx(): number {
  return historyIdx;
}

export function setHistoryIdx(idx: number): void {
  historyIdx = idx;
}

/** Lit kIdx dans un history.state quelconque (null si absent). */
export function readHistoryIdx(state: unknown): number | null {
  const v = (state as { kIdx?: unknown } | null)?.kIdx;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Le geste « retour » impose le sens de la navigation qu'il déclenche. */
export function forceNextDirection(dir: NavDirection): void {
  forcedNext = dir;
}

/** Consomme le sens imposé (une seule fois). */
export function takeForcedDirection(): NavDirection | null {
  const d = forcedNext;
  forcedNext = null;
  return d;
}

/** Vrai si l'utilisateur a demandé à réduire les animations. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ─── Écran précédent pendant le geste « retour » ───────────────────────────
// Le routeur note le chemin de chaque entrée d'historique (index kIdx) et, quand
// le geste est disponible (iOS), garde une copie figée du DOM de chaque page
// quittée. native-gestures.ts l'affiche derrière la page pendant le glissement.

const pathsByIdx = new Map<number, string>();
const snapshots = new Map<string, HTMLElement>();
const MAX_SNAPSHOTS = 6;
let snapshotsOn = false;

/** Mémorise le chemin d'une entrée d'historique. */
export function rememberPath(idx: number, path: string): void {
  pathsByIdx.set(idx, normalize(path));
}

/** Chemin connu d'une entrée d'historique (undefined si inconnu). */
export function pathAt(idx: number): string | undefined {
  return pathsByIdx.get(idx);
}

/** Active la copie des pages quittées (seulement là où le geste existe). */
export function enableSnapshots(on = true): void {
  snapshotsOn = on;
  if (!on) snapshots.clear();
}

export function snapshotsEnabled(): boolean {
  return snapshotsOn;
}

/** Range la copie d'une page quittée (les plus anciennes sont oubliées). */
export function storeSnapshot(path: string, el: HTMLElement): void {
  if (!snapshotsOn) return;
  const key = normalize(path);
  snapshots.delete(key);
  snapshots.set(key, el);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function getSnapshot(path: string): HTMLElement | undefined {
  return snapshots.get(normalize(path));
}

/** Émis (window) par le routeur juste avant de remplacer la page affichée. */
export const PAGE_SWAP_EVENT = 'k-page-swap';
