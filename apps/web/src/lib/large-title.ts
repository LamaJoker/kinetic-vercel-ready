/**
 * Grand titre qui se réduit (iOS « large title ») — chargé par native-ui.ts.
 *
 * Une seule barre du haut, créée ici et partagée par toutes les pages : en verre
 * flouté, sous la barre d'état (safe-area). Au défilement, quand le grand titre
 * de la page (h1[data-large-title], sinon le h1 de l'en-tête .k-nav) passe sous
 * la barre, celle-ci apparaît avec un titre compact centré qui monte en fondu ;
 * si la page a un bouton retour (.k-nav .k-back), un chevron retour apparaît à
 * gauche (il déclenche le bouton de la page). La progression suit le défilement
 * (opacité + translation seulement) ; sous mouvement réduit, simple fondu bref.
 *
 * La barre est décorative pour les lecteurs d'écran (aria-hidden) : le vrai
 * titre et le vrai bouton retour restent dans la page.
 */
import { prefersReducedMotion, PAGE_SWAP_EVENT } from './nav-motion';
import { STORAGE_KEYS } from '@kinetic/core';

/** Hauteur de la barre compacte (sous la safe-area), en px. */
export const TOPBAR_HEIGHT_PX = 44;
/** Course (px) sur laquelle le titre compact apparaît. */
export const TITLE_FADE_RANGE_PX = 22;

/**
 * Progression 0 → 1 de la barre compacte : 0 tant que le bas du grand titre est
 * à plus de `range` px sous la barre, 1 quand il est passé dessous.
 */
export function largeTitleProgress(
  titleBottom: number,
  barBottom: number,
  range = TITLE_FADE_RANGE_PX,
): number {
  if (range <= 0) return titleBottom <= barBottom ? 1 : 0;
  const p = (barBottom + range - titleBottom) / range;
  return p <= 0 ? 0 : p >= 1 ? 1 : p;
}

/** Sous mouvement réduit : tout ou rien (le fondu bref est porté par le CSS). */
export function snapProgress(p: number): number {
  return p >= 0.5 ? 1 : 0;
}

const CHEVRON =
  '<svg viewBox="0 0 12 20" width="12" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2 2 10l8 8"/></svg>';

type Bar = { root: HTMLElement; title: HTMLElement; back: HTMLButtonElement };

function createBar(): Bar {
  const root = document.createElement('div');
  root.className = 'k-topbar';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML =
    '<div class="k-topbar-bg"></div>' +
    '<div class="k-topbar-row">' +
    `<button type="button" class="k-topbar-back" tabindex="-1">${CHEVRON}<span>Retour</span></button>` +
    '<p class="k-topbar-title"></p>' +
    '</div>';
  document.body.appendChild(root);
  return {
    root,
    title: root.querySelector('.k-topbar-title') as HTMLElement,
    back: root.querySelector('.k-topbar-back') as HTMLButtonElement,
  };
}

/** Grand titre de la page affichée. */
function findTitle(): HTMLElement | null {
  const outlet = document.getElementById('app-outlet');
  if (!outlet) return null;
  return (
    outlet.querySelector<HTMLElement>('h1[data-large-title]') ??
    outlet.querySelector<HTMLElement>('.k-nav h1')
  );
}

let started = false;

export function initLargeTitle(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  let bar: Bar | null = null;
  let title: HTMLElement | null = null;
  let pageBack: HTMLElement | null = null;
  let frame = 0;
  let last = -1;

  const safeTop = (): number => {
    const v = parseFloat(getComputedStyle(document.body).paddingTop);
    return Number.isFinite(v) ? v : 0;
  };

  const apply = (p: number): void => {
    if (!bar || p === last) return;
    last = p;
    const root = bar.root;
    root.style.setProperty('--k-tb', String(p));
    root.classList.toggle('is-shown', p > 0.5);
    if (p > 0 && title) bar.title.textContent = title.textContent?.trim() ?? '';
  };

  const update = (): void => {
    frame = 0;
    if (!title || !title.isConnected) {
      bind();
      if (!title) return;
    }
    const rect = title.getBoundingClientRect();
    if (rect.height === 0) {
      apply(0);
      return;
    }
    const p = largeTitleProgress(rect.bottom, safeTop() + TOPBAR_HEIGHT_PX);
    apply(prefersReducedMotion() ? snapProgress(p) : p);
  };

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  /** Repère le titre (et le retour) de la page courante. */
  function bind(): void {
    title = findTitle();
    pageBack = document.querySelector<HTMLElement>('#app-outlet .k-nav .k-back');
    if (!title) {
      if (bar) bar.root.hidden = true;
      last = -1;
      return;
    }
    bar ??= createBar();
    bar.root.hidden = false;
    bar.root.classList.toggle('has-back', !!pageBack);
    bar.title.textContent = title.textContent?.trim() ?? '';
    last = -1;
    apply(0);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // Nouvelle page : on oublie l'ancien titre (le nouveau est relu après rendu).
  window.addEventListener(PAGE_SWAP_EVENT, () => {
    title = null;
    pageBack = null;
    if (bar) apply(0);
  });
  window.addEventListener(STORAGE_KEYS.EVENT_ROUTE_CHANGED, () => {
    bind();
    schedule();
  });

  // Toucher le chevron = toucher le bouton retour de la page (même logique).
  document.addEventListener('click', (e) => {
    if (!bar || !(e.target instanceof Element) || !bar.back.contains(e.target)) return;
    pageBack?.click();
  });

  bind();
  schedule();
}
