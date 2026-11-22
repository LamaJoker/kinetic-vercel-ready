/**
 * Visite de première utilisation (accueil) : bulles ancrées sur les vrais
 * éléments, découpe lumineuse autour, « Suivant » / « Passer ».
 *
 * Chargé à la demande par l'accueil quand la visite est en attente
 * (onboarding terminé, ou Profil › « Revoir la visite »). DOM construit ici, en
 * textContent (aucune expression Alpine : compatible build CSP). Les étapes, la
 * décision de lancement et le placement sont dans packages/core
 * (first-run-tour.domain.ts).
 *
 * - Une seule fois : l'état passe à 'done' dès l'ouverture.
 * - Jamais dans les builds E2E ni avec window.__kineticSkipOnboarding ; le
 *   parcours automatique (autotest) charge la démo sans mettre la visite en attente.
 * - prefers-reduced-motion : pas de glissement ni d'animation de geste.
 * - Se ferme si l'on quitte la page (navigation).
 */
import {
  STORAGE_KEYS,
  TOUR_STEPS,
  cropSpotForBubble,
  parseTourState,
  placeBubble,
  scrollDeltaForTarget,
  shouldStartTour,
  spotlightRect,
  tourProgressLabel,
  type Rect,
  type TourGesture,
  type TourStep,
} from '@kinetic/core';
import { hapticTap } from './haptics';
import { PAGE_SWAP_EVENT, prefersReducedMotion } from './nav-motion';
import './first-run-tour.css';

const START_DELAY_MS = 700;
const TARGET_WAIT_MS = 1200;

let active: { close: () => void } | null = null;

function readState() {
  try {
    return parseTourState(localStorage.getItem(STORAGE_KEYS.FIRST_RUN_TOUR));
  } catch {
    return null;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(STORAGE_KEYS.FIRST_RUN_TOUR, 'done');
  } catch {
    /* ignore */
  }
}

/** Lance la visite si elle est en attente et permise (pas de test E2E). */
export async function startFirstRunTourIfQueued(): Promise<boolean> {
  const state = readState();
  const ok = shouldStartTour({
    state,
    e2eBuild: import.meta.env.VITE_E2E === 'true',
    skipFlag:
      (window as Window & { __kineticSkipOnboarding?: boolean }).__kineticSkipOnboarding === true,
  });
  if (!ok || active) return false;
  markDone(); // une seule fois, même si l'app est fermée pendant la visite
  const path = window.location.pathname;
  await wait(START_DELAY_MS);
  if (window.location.pathname !== path) {
    // Accueil quitté avant l'ouverture : la visite reste à montrer au prochain passage.
    try {
      localStorage.setItem(STORAGE_KEYS.FIRST_RUN_TOUR, state ?? 'pending');
    } catch {
      /* ignore */
    }
    return false;
  }
  openTour(TOUR_STEPS);
  return true;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Premier élément visible (taille non nulle) parmi les sélecteurs de l'étape. */
function findTarget(step: TourStep): HTMLElement | null {
  for (const selector of step.targets) {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return node;
    }
  }
  return null;
}

async function waitForTarget(step: TourStep): Promise<HTMLElement | null> {
  if (step.targets.length === 0) return null;
  const start = Date.now();
  let found = findTarget(step);
  while (!found && Date.now() - start < TARGET_WAIT_MS) {
    await wait(120);
    found = findTarget(step);
  }
  return found;
}

/** Fait défiler jusqu'à la cible si elle n'est pas entièrement visible, puis attend la fin. */
async function bringIntoView(
  node: HTMLElement,
  bubbleHeight: number,
  reduced: boolean,
): Promise<void> {
  if (node.closest('nav') || getComputedStyle(node).position === 'fixed') return;
  const viewport = { width: window.innerWidth, height: window.innerHeight, safeBottom: 8 };
  const delta = scrollDeltaForTarget(rectOf(node), viewport, bubbleHeight);
  if (delta === 0) return;
  window.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' });
  // Attend que le défilement se stabilise (au plus ~900 ms).
  let last = -1;
  let still = 0;
  const start = Date.now();
  while (Date.now() - start < 900 && still < 4) {
    await nextFrame();
    const y = window.scrollY;
    still = y === last ? still + 1 : 0;
    last = y;
  }
}

function rectOf(node: HTMLElement): Rect {
  const r = node.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Petite scène qui mime le geste (ligne factice, doigt, menu ou fond rouge). */
function gestureDemo(kind: TourGesture): HTMLElement {
  const demo = el('div', `k-tour-demo k-tour-demo-${kind}`);
  demo.setAttribute('aria-hidden', 'true');
  if (kind === 'pull') {
    const ring = el('span', 'k-tour-demo-ring');
    const finger = el('span', 'k-tour-finger');
    demo.append(ring, finger);
    return demo;
  }
  const track = el('div', 'k-tour-demo-track');
  if (kind === 'swipe') track.append(el('span', 'k-tour-demo-action', 'Supprimer'));
  const row = el('div', 'k-tour-demo-row');
  row.append(el('span', 'k-tour-demo-dot'), el('span', 'k-tour-demo-line'));
  row.append(el('span', 'k-tour-demo-value', kind === 'swipe' ? '80 kg × 8' : '3 × 10'));
  track.append(row);
  demo.append(track, el('span', 'k-tour-finger'));
  if (kind === 'hold') {
    const menu = el('div', 'k-tour-demo-menu');
    menu.append(
      el('span', '', 'Remplacer'),
      el('span', '', 'Historique'),
      el('span', 'is-danger', 'Supprimer'),
    );
    demo.append(menu);
  }
  return demo;
}

function openTour(steps: readonly TourStep[]): void {
  const reduced = prefersReducedMotion();
  const previousFocus = document.activeElement as HTMLElement | null;
  const root = el('div', 'k-tour');
  if (reduced) root.classList.add('is-reduced');
  const catcher = el('div', 'k-tour-catcher');
  const spot = el('div', 'k-tour-spot');
  const bubble = el('div', 'k-tour-bubble');
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-modal', 'true');
  bubble.setAttribute('aria-labelledby', 'k-tour-title');
  bubble.setAttribute('aria-describedby', 'k-tour-body');
  const progress = el('p', 'k-tour-progress');
  const title = el('h2', 'k-tour-title');
  title.id = 'k-tour-title';
  const body = el('p', 'k-tour-body');
  body.id = 'k-tour-body';
  const demoSlot = el('div', 'k-tour-demo-slot');
  const dots = el('div', 'k-tour-dots');
  dots.setAttribute('aria-hidden', 'true');
  steps.forEach(() => dots.append(el('span', 'k-tour-dot')));
  const skip = el('button', 'k-tour-skip', 'Passer');
  skip.type = 'button';
  const next = el('button', 'k-tour-next', 'Suivant');
  next.type = 'button';
  const actions = el('div', 'k-tour-actions');
  actions.append(dots, skip, next);
  bubble.append(progress, title, body, demoSlot, actions);
  root.append(catcher, spot, bubble);
  document.body.append(root);

  let index = 0;
  let target: HTMLElement | null = null;
  let closed = false;
  let frame = 0;
  let resizeWatch: ResizeObserver | null = null;

  const layout = (): void => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const viewport = { width: vw, height: vh, safeTop: 8, safeBottom: 8 };
    const r = target ? rectOf(target) : null;
    const s = r
      ? cropSpotForBubble(spotlightRect(r, viewport, 8), bubble.offsetHeight, viewport)
      : null;
    if (s && s.width > 0 && s.height > 0) {
      spot.classList.remove('is-empty');
      Object.assign(spot.style, {
        top: `${s.top}px`,
        left: `${s.left}px`,
        width: `${s.width}px`,
        height: `${s.height}px`,
      });
    } else {
      spot.classList.add('is-empty');
      Object.assign(spot.style, {
        top: `${vh / 2}px`,
        left: `${vw / 2}px`,
        width: '0',
        height: '0',
      });
    }
    const size = { width: bubble.offsetWidth, height: bubble.offsetHeight };
    const p = placeBubble(s && s.width > 0 ? s : null, size, viewport);
    bubble.dataset.placement = p.placement;
    bubble.style.top = `${p.top}px`;
    bubble.style.left = `${p.left}px`;
    bubble.style.setProperty('--k-tour-arrow', `${p.arrowX}px`);
  };

  const relayout = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(layout);
  };

  const show = async (i: number): Promise<void> => {
    index = i;
    const step = steps[i]!;
    bubble.classList.add('is-changing');
    const found = await waitForTarget(step);
    if (closed || index !== i) return;
    progress.textContent = tourProgressLabel(i, steps.length);
    title.textContent = step.title;
    body.textContent = !found && step.fallbackBody ? step.fallbackBody : step.body;
    demoSlot.replaceChildren(...(step.gesture ? [gestureDemo(step.gesture)] : []));
    Array.from(dots.children).forEach((d, k) => d.classList.toggle('is-on', k === i));
    const last = i === steps.length - 1;
    next.textContent = last ? 'C’est parti' : 'Suivant';
    skip.hidden = last;
    if (found) await bringIntoView(found, bubble.offsetHeight, reduced);
    if (closed || index !== i) return;
    target = found;
    resizeWatch?.disconnect();
    if (found && typeof ResizeObserver !== 'undefined') {
      resizeWatch = new ResizeObserver(relayout);
      resizeWatch.observe(found);
    }
    layout();
    bubble.classList.remove('is-changing');
    next.focus({ preventScroll: true });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    active = null;
    cancelAnimationFrame(frame);
    resizeWatch?.disconnect();
    window.removeEventListener('resize', relayout);
    window.removeEventListener('scroll', relayout, true);
    window.removeEventListener(PAGE_SWAP_EVENT, close);
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('is-leaving');
    setTimeout(() => root.remove(), reduced ? 0 : 220);
    if (previousFocus && document.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Le focus reste dans la bulle.
      const focusables = [skip, next].filter((b) => !b.hidden);
      const pos = focusables.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      const to = (pos + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
      focusables[to]?.focus();
    }
  };

  next.addEventListener('click', () => {
    hapticTap();
    if (index >= steps.length - 1) close();
    else void show(index + 1);
  });
  skip.addEventListener('click', close);
  // Le reste de l'écran est inerte pendant la visite (pas de défilement non plus).
  const block = (e: Event): void => {
    if (!bubble.contains(e.target as Node)) e.preventDefault();
  };
  catcher.addEventListener('click', block);
  root.addEventListener('touchmove', block, { passive: false });
  root.addEventListener('wheel', block, { passive: false });
  window.addEventListener('resize', relayout);
  window.addEventListener('scroll', relayout, true);
  window.addEventListener(PAGE_SWAP_EVENT, close);
  document.addEventListener('keydown', onKey, true);

  active = { close };
  requestAnimationFrame(() => root.classList.add('is-in'));
  void show(0);
}

/** Ferme la visite en cours (tests, navigation). */
export function closeFirstRunTour(): void {
  active?.close();
}
