/**
 * Glisser une ligne (façon iOS Mail / Rappels) — directive Alpine `x-swipe`.
 *
 *   <div class="k-swipe" x-swipe:right="complete(id)" x-swipe:left="remove(id)"
 *        :data-swipe-right="canComplete ? 'on' : 'off'" data-swipe-left-label="Masquer">
 *     <div class="k-swipe-content">…ligne…</div>
 *   </div>
 *
 * - Vers la droite : action « positive » (turquoise, ex. cocher) ; la ligne
 *   revient en place avec un rebond élastique, puis l'action s'exécute.
 * - Vers la gauche : action « destructive » (corail, ex. masquer, supprimer) ; la
 *   ligne file hors de l'écran, puis l'action s'exécute (si la ligne est
 *   toujours là ensuite — action refusée —, elle revient).
 * - Seuil : SWIPE_COMMIT_RATIO de la largeur (ou un lancer rapide). Au
 *   franchissement : vibration légère (une fois) et fond plus vif. En deçà,
 *   relâcher = retour élastique, rien ne se passe.
 * - Désactiver un sens : data-swipe-right="off" / data-swipe-left="off".
 * - Libellés du fond : data-swipe-right-label / data-swipe-left-label (CSS attr()).
 * - Verrou d'axe : un défilement vertical ne déclenche jamais le glissement
 *   (touch-action: pan-y) ; un départ à moins de EDGE_GUARD_PX du bord gauche
 *   est laissé au retour par le bord (native-gestures.ts).
 * - Après un glissement, le clic qui suit est absorbé (pas d'ouverture de
 *   l'éditeur de la ligne).
 * - Mouvement réduit : pas de suivi animé du retour (CSS), l'action reste.
 *
 * Chargé à la demande (stub dans lazy-directives.ts). Styles : styles/gestes.css → .k-swipe*.
 */
import { hapticTap } from './haptics';

export const SWIPE_COMMIT_RATIO = 0.35;
export const SWIPE_MAX_COMMIT_PX = 140;
export const SWIPE_SLOP_PX = 10;
export const EDGE_GUARD_PX = 24;
/** Durée de sortie de la ligne (gauche) avant l'action. */
export const SWIPE_OUT_MS = 220;

export type SwipeDir = 'left' | 'right';

/** Seuil de validation (px) pour une ligne de largeur `width`. */
export function commitDistance(width: number): number {
  return Math.min(SWIPE_MAX_COMMIT_PX, Math.max(56, width * SWIPE_COMMIT_RATIO));
}

/**
 * Déplacement affiché pour un déplacement du doigt `dx` : suit le doigt jusqu'au
 * seuil, puis résiste (élasticité). Nul dans un sens désactivé.
 */
export function swipeOffset(
  dx: number,
  threshold: number,
  enabled: { left: boolean; right: boolean },
): number {
  if ((dx > 0 && !enabled.right) || (dx < 0 && !enabled.left)) return 0;
  const a = Math.abs(dx);
  if (a <= threshold) return dx;
  const extra = a - threshold;
  const resisted = threshold + extra * (1 / (1 + extra / (threshold * 0.9)));
  return Math.sign(dx) * resisted;
}

/** Sens validé au relâcher (distance ou lancer), ou null. */
export function swipeCommit(dx: number, velocity: number, threshold: number): SwipeDir | null {
  if (dx === 0) return null;
  const a = Math.abs(dx);
  const flung =
    a >= threshold * 0.5 && Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) >= 0.6;
  if (a >= threshold || flung) return dx > 0 ? 'right' : 'left';
  return null;
}

type Action = () => unknown;

interface SwipeState {
  actions: Partial<Record<SwipeDir, Action>>;
  destroy: () => void;
}

const states = new WeakMap<HTMLElement, SwipeState>();

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function setup(host: HTMLElement): SwipeState {
  const state: SwipeState = { actions: {}, destroy: () => undefined };
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let axis: 'x' | 'y' | null = null;
  let dx = 0;
  let lastT = 0;
  let lastX = 0;
  let velocity = 0;
  let threshold = 100;
  let armed = false;
  let busy = false;

  const content = (): HTMLElement =>
    (host.querySelector(':scope > .k-swipe-content') as HTMLElement | null) ??
    (host.firstElementChild as HTMLElement | null) ??
    host;

  const enabled = (): { left: boolean; right: boolean } => ({
    left: !!state.actions.left && host.dataset.swipeLeft !== 'off',
    right: !!state.actions.right && host.dataset.swipeRight !== 'off',
  });

  const place = (x: number, animated: boolean): void => {
    const c = content();
    c.classList.toggle('is-settling', animated);
    c.style.transform = x === 0 ? '' : `translate3d(${x.toFixed(1)}px, 0, 0)`;
    host.dataset.swipeDir = x > 0 ? 'right' : x < 0 ? 'left' : '';
    host.style.setProperty(
      '--k-swipe-p',
      Math.min(1, Math.abs(x) / Math.max(1, threshold)).toFixed(3),
    );
  };

  const reset = (animated: boolean): void => {
    place(0, animated);
    host.classList.remove('is-swiping', 'is-armed');
    armed = false;
  };

  const swallowNextClick = (): void => {
    const stop = (ev: Event): void => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    host.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => host.removeEventListener('click', stop, { capture: true }), 400);
  };

  const run = async (dir: SwipeDir): Promise<void> => {
    const action = state.actions[dir];
    if (!action) return reset(true);
    busy = true;
    if (dir === 'right') {
      reset(true);
      await Promise.resolve(action());
      busy = false;
      return;
    }
    // Gauche : la ligne file, puis l'action ; si la ligne existe encore ensuite
    // (action refusée ou sans effet), elle revient.
    const width = host.getBoundingClientRect().width || 400;
    place(-width, true);
    await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : SWIPE_OUT_MS));
    try {
      await Promise.resolve(action());
    } finally {
      busy = false;
      setTimeout(() => {
        if (host.isConnected) reset(true);
      }, 60);
    }
  };

  const onDown = (e: PointerEvent): void => {
    if (busy || pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const en = enabled();
    if (!en.left && !en.right) return;
    if (e.clientX < EDGE_GUARD_PX) return; // laissé au retour par le bord
    if ((e.target as Element | null)?.closest?.('input, textarea, select, [data-k-noswipe]'))
      return;
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    axis = null;
    dx = 0;
    velocity = 0;
    threshold = commitDistance(host.getBoundingClientRect().width);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(mx) < SWIPE_SLOP_PX && Math.abs(my) < SWIPE_SLOP_PX) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.2 ? 'x' : 'y';
      if (axis === 'y') {
        pointerId = null;
        return;
      }
      host.classList.add('is-swiping');
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    velocity = 0.7 * ((e.clientX - lastX) / dt) + 0.3 * velocity;
    lastX = e.clientX;
    lastT = e.timeStamp;
    dx = mx;
    const shown = swipeOffset(dx, threshold, enabled());
    place(shown, false);
    const nowArmed = Math.abs(shown) >= threshold;
    if (nowArmed !== armed) {
      armed = nowArmed;
      host.classList.toggle('is-armed', armed);
      if (armed) hapticTap();
    }
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (axis !== 'x') return;
    swallowNextClick();
    const shown = swipeOffset(dx, threshold, enabled());
    const dir = e.type === 'pointercancel' ? null : swipeCommit(shown, velocity, threshold);
    host.classList.remove('is-swiping');
    if (dir) void run(dir);
    else reset(true);
  };

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  state.destroy = () => {
    host.removeEventListener('pointerdown', onDown);
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointercancel', onUp);
  };
  return state;
}

/**
 * Déclare l'action d'un sens sur `host` (une directive par sens, même état).
 * Retourne la fonction de nettoyage de ce sens.
 */
export function bindSwipe(host: HTMLElement, dir: SwipeDir, action: Action): () => void {
  let state = states.get(host);
  if (!state) {
    state = setup(host);
    states.set(host, state);
  }
  state.actions[dir] = action;
  return () => {
    const s = states.get(host);
    if (!s) return;
    delete s.actions[dir];
    if (!s.actions.left && !s.actions.right) {
      s.destroy();
      states.delete(host);
    }
  };
}
