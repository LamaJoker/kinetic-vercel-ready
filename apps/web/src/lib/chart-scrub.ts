/**
 * Courbes à parcourir du doigt (façon app Santé) — directive Alpine `x-scrub`.
 *
 *   <div class="k-scrub" x-scrub="chartScrub()">
 *     <div x-svg="chartSvg()"></div>
 *   </div>
 *
 * L'expression rend la géométrie de la courbe (ScrubData, en unités du viewBox
 * du SVG), lue au moment du toucher (pas d'effet réactif). En glissant le doigt :
 * un curseur vertical suit, le point le plus proche se met en avant et une bulle
 * affiche sa date et sa valeur ; petit cran de vibration à chaque point traversé
 * (hapticTap, anti-rafale de haptics.ts) ; relâcher = tout disparaît.
 *
 * Le calque (curseur, point, bulle) est créé par la directive dans le conteneur
 * (position: relative), à côté du SVG que x-svg reconstruit à chaque rendu : il
 * n'est donc jamais effacé. Défilement vertical libre (touch-action: pan-y) :
 * un défilement annule le parcours (pointercancel). Le conteneur porte
 * data-k-noswipe (pas de retour par le bord depuis une courbe).
 *
 * Chargé à la demande (stub dans lazy-directives.ts) au premier toucher.
 * Styles : styles/gestes.css → .k-scrub*. Seules transform et opacity sont animées.
 */
import { hapticTap } from './haptics';

export interface ScrubPoint {
  /** Abscisse et ordonnée dans le viewBox du SVG. */
  x: number;
  y: number;
  /** Date affichée dans la bulle (« 12 nov. »). */
  label: string;
  /** Valeur affichée dans la bulle (« 82,4 kg »). */
  value: string;
}

export interface ScrubData {
  /** Largeur et hauteur du viewBox. */
  w: number;
  h: number;
  /** Étendue verticale du curseur (viewBox) ; par défaut toute la hauteur. */
  top?: number;
  bottom?: number;
  /** Points triés par x croissant. */
  points: ScrubPoint[];
}

/** Indice du point dont l'abscisse est la plus proche de `x` (points triés). */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo]! - x) <= Math.abs(xs[hi]! - x) ? lo : hi;
}

/** Position gauche de la bulle (px), centrée sur `cx` et gardée dans [0, width]. */
export function clampBubbleLeft(cx: number, bubbleW: number, width: number): number {
  const left = cx - bubbleW / 2;
  return Math.max(0, Math.min(width - bubbleW, left));
}

/** Données valides pour un parcours (au moins un point, viewBox non vide). */
export function isScrubData(v: unknown): v is ScrubData {
  if (!v || typeof v !== 'object') return false;
  const d = v as ScrubData;
  return d.w > 0 && d.h > 0 && Array.isArray(d.points) && d.points.length > 0;
}

interface Overlay {
  root: HTMLElement;
  line: HTMLElement;
  dot: HTMLElement;
  bubble: HTMLElement;
  date: HTMLElement;
  value: HTMLElement;
}

function makeOverlay(host: HTMLElement): Overlay {
  const part = (cls: string, parent: HTMLElement): HTMLElement => {
    const n = document.createElement('div');
    n.className = cls;
    parent.appendChild(n);
    return n;
  };
  const root = document.createElement('div');
  root.className = 'k-scrub-layer';
  root.setAttribute('aria-hidden', 'true');
  const line = part('k-scrub-line', root);
  const dot = part('k-scrub-dot', root);
  const bubble = part('k-scrub-bubble', root);
  const date = part('k-scrub-date', bubble);
  const value = part('k-scrub-value', bubble);
  host.appendChild(root);
  return { root, line, dot, bubble, date, value };
}

/**
 * Branche le parcours sur `host`. `read` rend la géométrie courante (ou null).
 * Retourne la fonction de nettoyage.
 */
export function bindChartScrub(host: HTMLElement, read: () => ScrubData | null): () => void {
  let overlay: Overlay | null = null;
  let data: ScrubData | null = null;
  let xs: number[] = [];
  let index = -1;
  let pointerId: number | null = null;
  let raf = 0;
  let lastX = 0;

  host.setAttribute('data-k-noswipe', '');

  const svgRect = (): DOMRect | null => {
    const svg = host.querySelector('svg');
    return svg ? svg.getBoundingClientRect() : null;
  };

  const render = (): void => {
    raf = 0;
    if (!data || !overlay) return;
    const r = svgRect();
    if (!r || r.width === 0) return;
    const hostRect = host.getBoundingClientRect();
    const kx = r.width / data.w;
    const ky = r.height / data.h;
    const i = nearestIndex(xs, (lastX - r.left) / kx);
    if (i < 0) return;
    const p = data.points[i]!;
    const px = r.left - hostRect.left + p.x * kx;
    const py = r.top - hostRect.top + p.y * ky;
    const top = r.top - hostRect.top + (data.top ?? 0) * ky;
    const bottom = r.top - hostRect.top + (data.bottom ?? data.h) * ky;
    overlay.line.style.transform = `translate3d(${px.toFixed(1)}px, ${top.toFixed(1)}px, 0) scaleY(${(bottom - top).toFixed(1)})`;
    overlay.dot.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
    if (i !== index) {
      if (index !== -1) hapticTap();
      index = i;
      overlay.date.textContent = p.label;
      overlay.value.textContent = p.value;
    }
    const bw = overlay.bubble.offsetWidth;
    const left = clampBubbleLeft(px, bw, hostRect.width);
    overlay.bubble.style.transform = `translate3d(${left.toFixed(1)}px, 0, 0)`;
  };

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(render);
  };

  const end = (): void => {
    if (pointerId === null) return;
    pointerId = null;
    index = -1;
    data = null;
    host.classList.remove('is-scrubbing');
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onDown = (e: PointerEvent): void => {
    if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const d = read();
    if (!isScrubData(d)) return;
    data = d;
    xs = d.points.map((p) => p.x);
    overlay ??= makeOverlay(host);
    pointerId = e.pointerId;
    lastX = e.clientX;
    index = -1;
    host.classList.add('is-scrubbing');
    try {
      host.setPointerCapture(e.pointerId);
    } catch {
      /* capture indisponible : on suit quand même */
    }
    schedule();
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    schedule();
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId === pointerId) end();
  };

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  host.addEventListener('lostpointercapture', onUp);

  return () => {
    end();
    host.removeEventListener('pointerdown', onDown);
    host.removeEventListener('pointermove', onMove);
    host.removeEventListener('pointerup', onUp);
    host.removeEventListener('pointercancel', onUp);
    host.removeEventListener('lostpointercapture', onUp);
    overlay?.root.remove();
  };
}
