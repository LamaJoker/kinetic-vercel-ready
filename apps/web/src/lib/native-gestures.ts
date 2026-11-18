/**
 * Gestes « natifs » — chargé à part par router.ts (initRouter), après le premier rendu.
 *
 * 1. Retour par glissement depuis le bord gauche (sous-pages seulement)
 *    - Le doigt doit se poser à moins de EDGE_ZONE_PX du bord gauche, puis aller
 *      franchement vers la droite (verrou d'axe après AXIS_SLOP_PX : un défilement
 *      vertical annule le geste, il ne démarre jamais en faisant défiler).
 *    - La page suit le doigt ; validé au-delà d'un tiers de la largeur ou d'une
 *      vitesse suffisante (shouldCommitBack), sinon elle revient en place.
 *    - Ignoré sur les onglets racines, sans page précédente dans l'application,
 *      quand une feuille / fenêtre est ouverte, sur un curseur (input range), un
 *      élément [data-k-noswipe] ou un carrousel horizontal déjà défilé.
 *    - Plateformes : app iOS native (WKWebView de Capacitor, sans geste système de
 *      retour) et application web iOS installée sur l'écran d'accueil (mode
 *      standalone, pas de geste système non plus). PAS dans Safari onglet (Safari a
 *      déjà son propre glissement depuis le bord : conflit) ni sur Android : le
 *      geste / bouton système « retour » y existe déjà (backButton dans mobile.ts).
 *
 * 2. Tirer pour rafraîchir (accueil, séances, corps, récupération, nutrition, profil)
 *    - Seulement quand la page est tout en haut ; verrou d'axe vertical.
 *    - Indicateur rond qui suit le doigt (élasticité façon iOS), vibration légère
 *      une seule fois au franchissement du seuil, puis rafraîchissement :
 *      refreshCurrentPage() relit les stores (xp, vitalite) et rappelle
 *      refresh() — ou à défaut init() — du composant de la page courante, et
 *      émet REFRESH_EVENT pour qui voudrait l'écouter.
 *    - Bloque le « tirer pour recharger » de Chrome Android (qui rechargerait
 *      toute l'application) pendant le geste.
 *
 * 3. Vibration légère à la sélection d'un onglet ou d'une pastille (délégation
 *    de clic : aucun attribut à ajouter dans les pages). Natif uniquement.
 *
 * Mouvement réduit : aucune animation (la page ne suit pas le doigt, la
 * validation est immédiate ; l'indicateur apparaît sans tourner).
 * Seules transform et opacity sont animées (styles/native-feel.css).
 */
import { Capacitor } from '@capacitor/core';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  isRootTab,
  currentHistoryIdx,
  forceNextDirection,
  takeForcedDirection,
  prefersReducedMotion,
} from './nav-motion';
import { hapticTap } from './haptics';

export const EDGE_ZONE_PX = 20;
export const AXIS_SLOP_PX = 10;
/** Distance (après élasticité) à dépasser pour lancer le rafraîchissement. */
export const PTR_THRESHOLD_PX = 64;
/** Limite de l'élasticité du tirer-pour-rafraîchir. */
export const PTR_LIMIT_PX = 140;
/** Position de l'indicateur pendant le rafraîchissement. */
export const PTR_HOLD_PX = 56;
/** Événement global émis à chaque rafraîchissement manuel. */
export const REFRESH_EVENT = STORAGE_KEYS.EVENT_REFRESH;
export const REFRESHABLE_ROUTES: readonly string[] = [
  '/',
  '/seances',
  '/bodyweight',
  '/vitalite',
  '/nutrition',
  '/profile',
];

// ─── Logique pure (testée dans tests/unit/native-gestures.test.ts) ─────────

/** Axe dominant une fois le doigt sorti de la zone morte, sinon null. */
export function lockAxis(dx: number, dy: number, slop = AXIS_SLOP_PX): 'x' | 'y' | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** Valider le retour ? Au-delà d'un tiers de largeur, ou lancé assez vite (px/ms). */
export function shouldCommitBack(dx: number, velocity: number, width: number): boolean {
  if (dx <= 0) return false;
  if (dx >= width / 3) return true;
  return velocity >= 0.5 && dx >= 24;
}

/** Élasticité façon UIScrollView : croît vite au début, plafonne à `limit`. */
export function rubberBand(distance: number, limit = PTR_LIMIT_PX): number {
  if (distance <= 0) return 0;
  return limit * (1 - 1 / ((distance * 0.55) / limit + 1));
}

export function isRefreshable(path: string): boolean {
  return REFRESHABLE_ROUTES.includes(path);
}

/** Retour par le bord : iOS natif, ou web iOS installé (standalone). Voir en-tête. */
export function edgeSwipeSupported(env: {
  native: boolean;
  platform: string;
  standalone: boolean;
}): boolean {
  if (env.native) return env.platform === 'ios';
  return env.standalone;
}

// ─── Rafraîchissement des données ──────────────────────────────────────────

type Reloadable = { reload?: () => unknown; init?: () => unknown; refresh?: () => unknown };

/** Relit les données de la page courante. Ne lève jamais. */
export async function refreshCurrentPage(): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const call = (target: Reloadable | undefined, ...names: Array<keyof Reloadable>): void => {
    if (!target) return;
    for (const name of names) {
      const fn = target[name];
      if (typeof fn === 'function') {
        jobs.push(Promise.resolve().then(() => fn.call(target)));
        return;
      }
    }
  };
  try {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    const alpine = (window as Window & { Alpine?: { store?: (n: string) => unknown } }).Alpine;
    call(alpine?.store?.('xp') as Reloadable | undefined, 'reload');
    call(alpine?.store?.('vitalite') as Reloadable | undefined, 'init');
    const el = document.getElementById('app-outlet')?.querySelector('[x-data]');
    const data = (el as (Element & { _x_dataStack?: Reloadable[] }) | null | undefined)
      ?._x_dataStack?.[0];
    call(data, 'refresh', 'init');
  } catch (err) {
    console.warn('[gestures] refresh failed:', err);
  }
  await Promise.allSettled(jobs);
}

// ─── Utilitaires DOM ───────────────────────────────────────────────────────

function outlet(): HTMLElement | null {
  return document.getElementById('app-outlet');
}

/** Feuille, fenêtre ou superposition ouverte : pas de geste de page. */
function overlayOpen(): boolean {
  const nodes = document.querySelectorAll<HTMLElement>(
    '.k-backdrop, [role="dialog"], [aria-modal="true"]',
  );
  for (const n of nodes) if (n.getClientRects().length > 0) return true;
  return false;
}

/** Cible qui gère elle-même les glissements horizontaux. */
function horizontalOwner(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest('input[type="range"], [data-k-noswipe]')) return true;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth && el.scrollLeft > 0) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** Un conteneur défilant (liste dans une feuille…) n'est pas en haut. */
function scrolledAncestor(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

function pageScrollTop(): number {
  return window.scrollY || document.scrollingElement?.scrollTop || 0;
}

type Tracker = { x: number; t: number; v: number };
function track(tr: Tracker, x: number): void {
  const now = performance.now();
  const dt = now - tr.t;
  if (dt > 0) tr.v = 0.6 * ((x - tr.x) / dt) + 0.4 * tr.v;
  tr.x = x;
  tr.t = now;
}

// ─── 1. Retour par le bord gauche ──────────────────────────────────────────

function initEdgeSwipeBack(): void {
  let startX = 0;
  let startY = 0;
  let axis: 'x' | 'y' | null = null;
  let dx = 0;
  let host: HTMLElement | null = null;
  const tr: Tracker = { x: 0, t: 0, v: 0 };
  const reduced = (): boolean => prefersReducedMotion();

  const detach = (): void => {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
  };

  const settle = (el: HTMLElement, to: number, done: () => void): void => {
    if (reduced()) {
      done();
      return;
    }
    el.style.transition = 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transform = `translate3d(${to}px, 0, 0)`;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      el.removeEventListener('transitionend', finish);
      done();
    };
    el.addEventListener('transitionend', finish);
    setTimeout(finish, 320);
  };

  const reset = (el: HTMLElement): void => {
    el.style.removeProperty('transform');
    el.style.removeProperty('transition');
    el.classList.remove('k-swiping-back');
  };

  function onStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    if (t.clientX > EDGE_ZONE_PX) return;
    if (isRootTab(window.location.pathname) || currentHistoryIdx() <= 0) return;
    if (overlayOpen() || horizontalOwner(e.target)) return;
    host = outlet();
    if (!host) return;
    startX = t.clientX;
    startY = t.clientY;
    axis = null;
    dx = 0;
    tr.x = t.clientX;
    tr.t = performance.now();
    tr.v = 0;
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  }

  function onMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t || !host) return;
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!axis) {
      axis = lockAxis(mx, my);
      if (!axis) return;
      if (axis === 'y' || mx < 0) {
        axis = 'y';
        detach();
        return;
      }
      host.classList.add('k-swiping-back');
    }
    if (e.cancelable) e.preventDefault();
    dx = Math.max(0, mx);
    track(tr, t.clientX);
    if (!reduced()) host.style.transform = `translate3d(${dx}px, 0, 0)`;
  }

  function onEnd(): void {
    detach();
    const el = host;
    host = null;
    if (!el || axis !== 'x') return;
    const width = window.innerWidth || 375;
    if (shouldCommitBack(dx, tr.v, width)) {
      const from = window.location.pathname;
      settle(el, width, () => {
        forceNextDirection('swipe');
        window.history.back();
        // Filet : si rien n'a changé (pas d'historique), la page revient.
        setTimeout(() => {
          if (window.location.pathname === from) {
            takeForcedDirection();
            reset(el);
          }
        }, 600);
      });
    } else {
      settle(el, 0, () => reset(el));
    }
  }

  document.addEventListener('touchstart', onStart, { passive: true });
}

// ─── 2. Tirer pour rafraîchir ──────────────────────────────────────────────

function createIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'k-ptr';
  el.setAttribute('aria-hidden', 'true');
  // Anneau : piste discrète + arc qui se remplit avec la traction.
  el.innerHTML =
    '<svg class="k-ptr-ring" viewBox="0 0 24 24" fill="none" stroke-width="2.6" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="8" class="k-ptr-track"/>' +
    '<circle cx="12" cy="12" r="8" class="k-ptr-arc" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>' +
    '</svg>';
  document.body.appendChild(el);
  return el;
}

function initPullToRefresh(edgeSwipe: boolean): void {
  let indicator: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let axis: 'x' | 'y' | null = null;
  let pull = 0;
  let armed = false;
  let tapped = false;
  let refreshing = false;
  let host: HTMLElement | null = null;

  const ind = (): HTMLElement => (indicator ??= createIndicator());
  const arc = (): SVGCircleElement | null => ind().querySelector('.k-ptr-arc');

  const paint = (y: number, progress: number): void => {
    const i = ind();
    i.style.transform = `translate3d(-50%, ${y}px, 0) rotate(${Math.round(progress * 270)}deg)`;
    i.style.opacity = String(Math.min(1, progress * 1.2));
    arc()?.setAttribute('stroke-dashoffset', String(Math.round(100 - Math.min(1, progress) * 80)));
    if (host && !prefersReducedMotion()) {
      host.style.transform = y > 0 ? `translate3d(0, ${y}px, 0)` : '';
    }
  };

  const detach = (): void => {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
  };

  const retract = (): void => {
    const i = ind();
    const el = host ?? outlet();
    i.classList.add('is-settling');
    i.classList.remove('is-refreshing', 'is-armed');
    el?.classList.add('k-ptr-settling');
    paint(0, 0);
    if (el) el.style.transform = '';
    setTimeout(() => {
      i.classList.remove('is-settling');
      el?.classList.remove('k-ptr-settling');
      el?.style.removeProperty('transform');
    }, 320);
    host = null;
  };

  function onStart(e: TouchEvent): void {
    if (refreshing || e.touches.length !== 1) return;
    if (!isRefreshable(window.location.pathname)) return;
    const t = e.touches[0]!;
    if (edgeSwipe && t.clientX <= EDGE_ZONE_PX) return;
    if (pageScrollTop() > 0 || overlayOpen() || scrolledAncestor(e.target)) return;
    host = outlet();
    startX = t.clientX;
    startY = t.clientY;
    axis = null;
    pull = 0;
    armed = false;
    tapped = false;
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  }

  function onMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t) return;
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!axis) {
      axis = lockAxis(mx, my);
      if (!axis) return;
      if (axis === 'x' || my < 0 || pageScrollTop() > 0) {
        axis = 'x';
        detach();
        host = null;
        return;
      }
      ind().classList.remove('is-settling');
      host?.classList.remove('k-ptr-settling');
    }
    // Remonter au-dessus du point de départ rend la main au défilement.
    if (my <= 0) {
      if (pull > 0) paint(0, 0);
      pull = 0;
      armed = false;
      return;
    }
    if (e.cancelable) e.preventDefault();
    pull = rubberBand(my);
    armed = pull >= PTR_THRESHOLD_PX;
    if (armed && !tapped) {
      tapped = true; // une seule vibration par geste
      hapticTap();
    }
    ind().classList.toggle('is-armed', armed);
    paint(pull, pull / PTR_THRESHOLD_PX);
  }

  function onEnd(): void {
    detach();
    if (axis !== 'y') return;
    void finish();
  }

  async function finish(): Promise<void> {
    if (!armed) {
      retract();
      return;
    }
    refreshing = true;
    const i = ind();
    const el = host;
    i.classList.add('is-settling', 'is-refreshing');
    el?.classList.add('k-ptr-settling');
    paint(PTR_HOLD_PX, 1);
    el?.setAttribute('aria-busy', 'true');
    const started = Date.now();
    await refreshCurrentPage();
    // Durée minimale : sans elle l'indicateur clignote et l'action paraît ratée.
    const wait = 600 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el?.setAttribute('aria-busy', 'false');
    host = el;
    retract();
    refreshing = false;
  }

  document.addEventListener('touchstart', onStart, { passive: true });
}

// ─── 3. Vibration de sélection ─────────────────────────────────────────────

function initSelectionHaptics(): void {
  document.addEventListener(
    'click',
    (e) => {
      const el = (e.target as Element | null)?.closest?.(
        'a.k-tab, button.k-seg-item, button.k-chip, a.k-chip, [role="tab"], [role="radio"]',
      );
      if (el) hapticTap();
    },
    { capture: true, passive: true },
  );
}

// ─── Initialisation ────────────────────────────────────────────────────────

let started = false;

export function initNativeGestures(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  let native = false;
  let platform = 'web';
  try {
    native = Capacitor.isNativePlatform();
    platform = Capacitor.getPlatform();
  } catch {
    /* Capacitor indisponible : web */
  }
  if (native) initSelectionHaptics();

  const touch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  if (!touch) return;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const edge = edgeSwipeSupported({ native, platform, standalone });
  if (edge) initEdgeSwipeBack();
  initPullToRefresh(edge);
}
