/**
 * Calques de page déplaçables — utilisé par les gestes (native-gestures.ts) et
 * les feuilles (sheets.ts).
 *
 * Problème : une transformation posée sur #app-outlet (ou sur un bloc de la
 * page) devient le repère de ses descendants `position: fixed` (minuteur de
 * repos, fond de feuille…), qui sautent alors à une autre place à l'écran.
 * Solution : on découpe la page en « calques » :
 *   - flow  : les plus grands sous-arbres qui ne contiennent AUCUN élément fixed
 *             visible (on peut les transformer sans rien casser) ;
 *   - fixed : les éléments fixed visibles eux-mêmes (une transformation sur
 *             l'élément fixed lui-même ne change pas son repère).
 * On déplace ensuite chaque calque avec les propriétés individuelles
 * `translate` / `scale` (elles se cumulent avec un `transform` déjà présent,
 * ex. -translate-x-1/2 de Tailwind) ; repli sur `transform` sinon.
 */

/** Sélecteur des candidats possibles (évite getComputedStyle sur toute la page). */
const FIXED_CANDIDATES = '.fixed, [class*="fixed"], .k-backdrop, [style*="fixed"]';

export type IsFixed = (el: HTMLElement) => boolean;

/** Élément réellement `position: fixed` et affiché. */
export const isVisibleFixed: IsFixed = (el) =>
  el.getClientRects().length > 0 && getComputedStyle(el).position === 'fixed';

/** Éléments fixed visibles sous `root` (seulement les plus externes). */
export function fixedElements(root: Element, isFixed: IsFixed = isVisibleFixed): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(FIXED_CANDIDATES)).filter((el) =>
    isFixed(el),
  );
  return found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
}

/** Découpe `root` en calques déplaçables sans casser les éléments fixed (voir en-tête). */
export function pageLayers(
  root: Element,
  isFixed: IsFixed = isVisibleFixed,
): { flow: HTMLElement[]; fixed: HTMLElement[] } {
  const fixed = fixedElements(root, isFixed);
  const flow: HTMLElement[] = [];
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.tagName === 'TEMPLATE' || child.tagName === 'SCRIPT') continue;
      if (fixed.includes(child)) continue;
      if (fixed.some((f) => child.contains(f))) walk(child);
      else flow.push(child);
    }
  };
  walk(root);
  return { flow, fixed };
}

let individual: boolean | null = null;
/** `translate` / `scale` individuels (Safari 14.1+, Chrome 104+). */
function individualTransforms(): boolean {
  if (individual === null) {
    try {
      individual = typeof CSS !== 'undefined' && CSS.supports('translate', '1px 1px');
    } catch {
      individual = false;
    }
  }
  return individual;
}

const PROPS = ['translate', 'scale', 'transform', 'transition', 'transform-origin', 'will-change'];

export type Move = { x?: number; y?: number; scale?: number; origin?: string };

/** Déplace un ensemble de calques ; restore() rend les styles d'origine. */
export class LayerMover {
  private readonly saved = new Map<HTMLElement, string[]>();

  constructor(readonly els: readonly HTMLElement[]) {
    for (const el of els) {
      this.saved.set(
        el,
        PROPS.map((p) => el.style.getPropertyValue(p)),
      );
      el.style.setProperty('will-change', 'transform');
    }
  }

  /** `transition` : transition CSS à poser (ex. « 260ms ease »), ou rien pour suivre le doigt. */
  set(move: Move, transition?: string, origins?: ReadonlyMap<HTMLElement, string>): void {
    const { x = 0, y = 0, scale } = move;
    const ind = individualTransforms();
    for (const el of this.els) {
      if (transition) {
        el.style.setProperty(
          'transition',
          ind ? `translate ${transition}, scale ${transition}` : `transform ${transition}`,
        );
      } else {
        el.style.setProperty('transition', 'none');
      }
      const origin = origins?.get(el) ?? move.origin;
      if (origin) el.style.setProperty('transform-origin', origin);
      if (ind) {
        el.style.setProperty('translate', x || y ? `${x}px ${y}px` : 'none');
        el.style.setProperty('scale', scale !== undefined && scale !== 1 ? String(scale) : 'none');
      } else {
        const parts: string[] = [];
        if (x || y) parts.push(`translate3d(${x}px, ${y}px, 0)`);
        if (scale !== undefined && scale !== 1) parts.push(`scale(${scale})`);
        el.style.setProperty('transform', parts.join(' ') || 'none');
      }
    }
  }

  restore(): void {
    for (const [el, values] of this.saved) {
      PROPS.forEach((p, i) => {
        const v = values[i];
        if (v) el.style.setProperty(p, v);
        else el.style.removeProperty(p);
      });
    }
  }
}

/**
 * Origine de transformation qui fait réduire tous les calques autour du MÊME
 * point de l'écran (cx, cy) : chaque calque se réduit comme un seul écran.
 */
export function sharedOrigin(rect: { left: number; top: number }, cx: number, cy: number): string {
  return `${Math.round(cx - rect.left)}px ${Math.round(cy - rect.top)}px`;
}

/** Classes d'un calque fixed (une copie figée n'a pas à les montrer). */
function looksFixed(el: Element): boolean {
  for (const c of Array.from(el.classList)) {
    if (c === 'fixed' || c.endsWith(':fixed') || c === 'k-backdrop') return true;
  }
  return false;
}

/** Attributs retirés d'une copie : directives Alpine, id, focus, ARIA. */
function droppedAttr(name: string): boolean {
  return (
    name === 'id' ||
    name === 'tabindex' ||
    name === 'for' ||
    name.startsWith('x-') ||
    name.startsWith('@') ||
    name.startsWith(':') ||
    name.startsWith('aria-') ||
    name.startsWith('data-k-menu')
  );
}

/**
 * Copie figée et inerte d'un morceau de page (écran précédent du geste
 * « retour », aperçu du menu contextuel) : sans directives Alpine (sinon Alpine
 * l'initialiserait hors de son composant), sans id en double, sans calques fixed
 * ni transformations temporaires.
 */
export function inertClone(src: Element): HTMLElement {
  const copy = src.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('template, script').forEach((n) => n.remove());
  for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))]) {
    if (el !== copy && looksFixed(el)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (droppedAttr(attr.name)) el.removeAttribute(attr.name);
    }
    // Transformations temporaires seulement (calques déplacés par LayerMover,
    // marqués will-change) : celles du contenu (barre de progression…) restent.
    if (el.style?.getPropertyValue('will-change') === 'transform') {
      for (const p of ['translate', 'scale', 'transform', 'will-change', 'transition']) {
        el.style.removeProperty(p);
      }
    }
  }
  copy.classList.remove('k-route-in', 'k-swiping-back', 'k-cm-pressing');
  return copy;
}
