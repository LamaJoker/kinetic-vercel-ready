/**
 * Feuilles façon iOS — comportement générique de toutes les feuilles
 * (`.k-backdrop > .k-sheet`, cf. styles.css), chargé par native-ui.ts.
 * Aucun attribut à ajouter dans les pages.
 *
 * 1. Glisser vers le bas pour fermer : la feuille suit le doigt (depuis la
 *    poignée ou n'importe où quand son contenu est tout en haut) ; fermée
 *    au-delà d'un tiers de sa hauteur ou si lancée assez vite
 *    (shouldDismissSheet), sinon retour élastique. La fermeture passe par le
 *    code existant de la page : un clic sur le fond (`@click.self`), à défaut
 *    la touche Échap (`@keydown.escape.window`) ; si rien ne ferme, la feuille
 *    revient en place.
 * 2. L'écran derrière recule (scale 0,94 + coins arrondis) tant qu'une feuille
 *    est ouverte, et revient progressivement pendant le glissement.
 *    Les calques de la page sont réduits séparément (page-layers.ts) pour ne
 *    pas déplacer le fond de la feuille ni les éléments fixed.
 * 3. Focus : à l'ouverture, s'il est resté hors de la feuille, il y entre ;
 *    à la fermeture, il revient sur l'élément qui l'avait (bouton d'ouverture).
 *
 * Mouvement réduit : pas de recul ni de suivi ; la fermeture au glissé reste
 * possible, sans animation.
 */
import { prefersReducedMotion, PAGE_SWAP_EVENT } from './nav-motion';
import { LayerMover, pageLayers, sharedOrigin } from './page-layers';

/** Réduction de l'écran derrière une feuille ouverte. */
export const RECEDE_SCALE = 0.94;
const OPEN_EASE = '420ms cubic-bezier(0.32, 0.72, 0, 1)';
const CLOSE_EASE = '300ms cubic-bezier(0.32, 0.72, 0, 1)';

/** Fermer la feuille ? Au-delà d'un tiers de sa hauteur (220 px au plus), ou lancée vers le bas. */
export function shouldDismissSheet(dy: number, velocity: number, height: number): boolean {
  if (dy <= 0) return false;
  if (dy >= Math.min(height / 3, 220)) return true;
  return velocity >= 0.5 && dy >= 24;
}

/** Échelle de l'écran derrière pendant le glissement (0,94 → 1 quand la feuille descend). */
export function recedeScaleFor(dy: number, height: number, scale = RECEDE_SCALE): number {
  if (height <= 0 || dy <= 0) return scale;
  return scale + (1 - scale) * Math.min(1, dy / height);
}

/** Point fixe de la réduction (comme iOS : l'écran descend un peu et rétrécit). */
function recedeCenter(): { cx: number; cy: number } {
  return { cx: window.innerWidth / 2, cy: window.innerHeight * 0.3 };
}

function visible(el: Element | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

/** Fond de feuille ouvert le plus haut (dernier dans le document). */
function openBackdrop(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('#app-outlet .k-backdrop')).filter(
    (b) => visible(b) && b.querySelector('.k-sheet'),
  );
  return all[all.length - 1] ?? null;
}

type Recede = { mover: LayerMover; frame: HTMLElement; scaleAt: (s: number, t?: string) => void };

function startRecede(backdrop: HTMLElement): Recede | null {
  const host = document.getElementById('app-outlet');
  if (!host || prefersReducedMotion()) return null;
  const { flow, fixed } = pageLayers(host);
  const shell = Array.from(
    document.querySelectorAll<HTMLElement>('.k-tabbar-dock, .k-topbar, .k-session-banner'),
  ).filter((el) => visible(el));
  const targets = [
    ...flow,
    ...fixed.filter((el) => el !== backdrop && !el.classList.contains('k-backdrop')),
    ...shell,
  ];
  const { cx, cy } = recedeCenter();
  const origins = new Map<HTMLElement, string>();
  for (const el of targets) origins.set(el, sharedOrigin(el.getBoundingClientRect(), cx, cy));
  const mover = new LayerMover(targets);
  // Coins arrondis : cadre noir autour du rectangle réduit (sous le fond assombri).
  const frame = document.createElement('div');
  frame.className = 'k-recede-frame';
  frame.setAttribute('aria-hidden', 'true');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const k = 1 - RECEDE_SCALE;
  frame.style.inset = `${cy * k}px ${(vw - cx) * k}px ${(vh - cy) * k}px ${cx * k}px`;
  document.body.appendChild(frame);
  const scaleAt = (s: number, t?: string): void => {
    mover.set({ scale: s }, t, origins);
    frame.style.transition = t ? `opacity ${t}` : 'none';
    frame.style.opacity = String(Math.max(0, Math.min(1, (1 - s) / k)));
  };
  scaleAt(1);
  void frame.offsetWidth;
  scaleAt(RECEDE_SCALE, OPEN_EASE);
  return { mover, frame, scaleAt };
}

function endRecede(r: Recede | null, animate = true): void {
  if (!r) return;
  if (!animate) {
    r.mover.restore();
    r.frame.remove();
    return;
  }
  r.scaleAt(1, CLOSE_EASE);
  setTimeout(() => {
    r.mover.restore();
    r.frame.remove();
  }, 320);
}

let started = false;

export function initSheets(): void {
  if (started || typeof document === 'undefined') return;
  started = true;

  let current: HTMLElement | null = null; // fond ouvert
  let recede: Recede | null = null;
  let returnFocus: HTMLElement | null = null;
  let checkQueued = false;

  const sync = (): void => {
    checkQueued = false;
    const next = openBackdrop();
    if (next === current) return;
    // Fermeture (ou remplacement) de la feuille précédente.
    if (current) {
      endRecede(recede, true);
      recede = null;
      document.documentElement.classList.remove('k-sheet-open');
      const back = returnFocus;
      returnFocus = null;
      if (!next && back?.isConnected) {
        try {
          back.focus({ preventScroll: true });
        } catch {
          /* élément non focusable */
        }
      }
    }
    current = next;
    if (!next) return;
    document.documentElement.classList.add('k-sheet-open');
    recede = startRecede(next);
    const sheet = next.querySelector<HTMLElement>('.k-sheet');
    const active = document.activeElement as HTMLElement | null;
    if (sheet && !sheet.contains(active)) {
      returnFocus = active && active !== document.body ? active : null;
      if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
      try {
        sheet.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  };
  const queue = (): void => {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(sync);
  };

  // Ouverture / fermeture : x-if ajoute ou retire le fond, x-show change son style.
  const touches = (n: Node): boolean =>
    n instanceof Element && (n.matches('.k-backdrop') || !!n.querySelector('.k-backdrop'));
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target instanceof Element && r.target.matches('.k-backdrop')) return queue();
        continue;
      }
      for (const n of Array.from(r.addedNodes)) if (touches(n)) return queue();
      for (const n of Array.from(r.removedNodes)) if (touches(n)) return queue();
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  window.addEventListener(PAGE_SWAP_EVENT, () => {
    endRecede(recede, false);
    recede = null;
    current = null;
    returnFocus = null;
    document.documentElement.classList.remove('k-sheet-open');
  });

  initSheetDrag(() => recede);
  queue();
}

// ─── Glisser pour fermer ───────────────────────────────────────────────────

/** Cible qui gère elle-même son glissement (curseur, carrousel, zone défilée). */
function ownsGesture(target: EventTarget | null, sheet: HTMLElement): boolean {
  let el = target instanceof Element ? target : null;
  if (el?.closest('input[type="range"], [data-k-noswipe], textarea, select')) return true;
  while (el && el !== sheet) {
    if (el instanceof HTMLElement && el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

function initSheetDrag(getRecede: () => Recede | null): void {
  let sheet: HTMLElement | null = null;
  let backdrop: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let axis: 'x' | 'y' | null = null;
  let dy = 0;
  let lastY = 0;
  let lastT = 0;
  let v = 0;

  const detach = (): void => {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
  };

  const place = (el: HTMLElement, y: number, t?: string): void => {
    el.style.animation = 'none'; // l'animation d'entrée (fill both) bloquerait la transformation
    el.style.transition = t ? `transform ${t}` : 'none';
    el.style.transform = y ? `translate3d(0, ${y}px, 0)` : 'none';
  };

  const clean = (el: HTMLElement): void => {
    for (const p of ['transform', 'transition', 'animation']) el.style.removeProperty(p);
  };

  function onStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const target = e.target instanceof Element ? e.target : null;
    const s = target?.closest<HTMLElement>('.k-sheet');
    const b = s?.closest<HTMLElement>('.k-backdrop');
    if (!s || !b || ownsGesture(target, s)) return;
    sheet = s;
    backdrop = b;
    const t = e.touches[0]!;
    startX = t.clientX;
    startY = t.clientY;
    lastY = t.clientY;
    lastT = performance.now();
    axis = null;
    dy = 0;
    v = 0;
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
  }

  function onMove(e: TouchEvent): void {
    const t = e.touches[0];
    if (!t || !sheet) return;
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(my) > Math.abs(mx) ? 'y' : 'x';
      // Vers le haut, à l'horizontale, ou contenu déjà défilé : défilement normal.
      if (axis === 'x' || my < 0 || sheet.scrollTop > 0) {
        axis = 'x';
        detach();
        sheet = null;
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    dy = Math.max(0, my);
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) v = 0.6 * ((t.clientY - lastY) / dt) + 0.4 * v;
    lastY = t.clientY;
    lastT = now;
    if (prefersReducedMotion()) return;
    place(sheet, dy);
    getRecede()?.scaleAt(recedeScaleFor(dy, sheet.offsetHeight));
  }

  function onEnd(): void {
    detach();
    const s = sheet;
    const b = backdrop;
    sheet = null;
    backdrop = null;
    if (!s || !b || axis !== 'y') return;
    const h = s.offsetHeight;
    const reduced = prefersReducedMotion();
    if (shouldDismissSheet(dy, v, h)) {
      if (reduced) {
        close(s, b);
        return;
      }
      place(s, h + 48, '240ms cubic-bezier(0.32, 0.72, 0, 1)');
      getRecede()?.scaleAt(1, '240ms cubic-bezier(0.32, 0.72, 0, 1)');
      setTimeout(() => close(s, b), 220);
    } else if (dy > 0 && !reduced) {
      // Retour élastique.
      place(s, 0, '420ms cubic-bezier(0.34, 1.4, 0.64, 1)');
      getRecede()?.scaleAt(RECEDE_SCALE, '420ms cubic-bezier(0.32, 0.72, 0, 1)');
      setTimeout(() => {
        s.style.removeProperty('transition');
      }, 440);
    }
  }

  /** Ferme par le code de la page : clic sur le fond, sinon Échap ; sinon la feuille revient. */
  function close(s: HTMLElement, b: HTMLElement): void {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const stillOpen = (): boolean => visible(b) && b.contains(s);
    requestAnimationFrame(() => {
      if (!stillOpen()) return clean(s);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Laisse le temps à une éventuelle transition de sortie (x-transition).
      setTimeout(() => {
        if (!stillOpen()) return clean(s);
        place(s, 0, '420ms cubic-bezier(0.34, 1.4, 0.64, 1)');
        getRecede()?.scaleAt(RECEDE_SCALE, OPEN_EASE);
      }, 320);
    });
  }

  document.addEventListener('touchstart', onStart, { passive: true });
}
