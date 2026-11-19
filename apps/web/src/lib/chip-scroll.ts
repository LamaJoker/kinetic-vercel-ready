/**
 * Rangée de pastilles défilante — directive Alpine `x-chip-scroll`.
 *
 * Pour un contrôle segmenté trop chargé (5-6 choix : onglets Progression,
 * filtres Succès), le conteneur `.k-seg.k-seg-scroll` devient une rangée de
 * pastilles qui défile horizontalement (styles/finitions.css). La directive :
 *   - amène le choix actif ([aria-pressed|aria-selected="true"] ou .on) dans
 *     la zone visible — au chargement sans animation, puis en glissant doux à
 *     chaque changement (y compris programmatique : MutationObserver) ;
 *   - pose data-fade-start / data-fade-end selon qu'il reste du contenu à
 *     gauche / à droite, pour le fondu des bords (masque CSS).
 *
 * Aucune expression (`<div class="k-seg k-seg-scroll" x-chip-scroll>`).
 * Mouvement réduit : défilement immédiat.
 */

/** Marge laissée autour du choix actif quand on le ramène à l'écran (px). */
export const CHIP_SCROLL_MARGIN = 24;

/**
 * Position de défilement qui rend l'élément [itemLeft, itemLeft+itemWidth]
 * visible avec une marge, en bougeant le moins possible (comme iOS). Toutes
 * les mesures sont relatives au début du contenu défilant.
 */
export function chipScrollTarget(
  viewport: number,
  contentWidth: number,
  scrollLeft: number,
  itemLeft: number,
  itemWidth: number,
  margin: number = CHIP_SCROLL_MARGIN,
): number {
  const max = Math.max(0, contentWidth - viewport);
  let next = scrollLeft;
  if (itemLeft - margin < scrollLeft) next = itemLeft - margin;
  else if (itemLeft + itemWidth + margin > scrollLeft + viewport)
    next = itemLeft + itemWidth + margin - viewport;
  return Math.round(Math.min(max, Math.max(0, next)));
}

/** Fondus des bords : contenu caché à gauche / à droite (tolérance 2 px). */
export function chipFades(
  viewport: number,
  contentWidth: number,
  scrollLeft: number,
): { start: boolean; end: boolean } {
  return {
    start: scrollLeft > 2,
    end: scrollLeft + viewport < contentWidth - 2,
  };
}

const ACTIVE_SELECTOR = ":scope > :is(.on, [aria-pressed='true'], [aria-selected='true'])";

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Branche la rangée ; renvoie la fonction de nettoyage. */
export function bindChipScroll(el: HTMLElement): () => void {
  const updateFades = (): void => {
    const f = chipFades(el.clientWidth, el.scrollWidth, el.scrollLeft);
    el.toggleAttribute('data-fade-start', f.start);
    el.toggleAttribute('data-fade-end', f.end);
  };

  const reveal = (smooth: boolean): void => {
    const active = el.querySelector<HTMLElement>(ACTIVE_SELECTOR);
    if (!active || el.clientWidth === 0) {
      updateFades();
      return;
    }
    const target = chipScrollTarget(
      el.clientWidth,
      el.scrollWidth,
      el.scrollLeft,
      active.offsetLeft, // repère : le conteneur (positionné), indépendant du défilement
      active.offsetWidth,
    );
    if (target !== Math.round(el.scrollLeft)) {
      const behavior: ScrollBehavior = smooth && !reducedMotion() ? 'smooth' : 'auto';
      if (typeof el.scrollTo === 'function') el.scrollTo({ left: target, behavior });
      else el.scrollLeft = target;
    }
    updateFades();
  };

  let raf = 0;
  const schedule = (smooth: boolean): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => reveal(smooth));
  };

  // offsetLeft des pastilles relatif au conteneur : il doit être positionné.
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

  schedule(false);
  const mo = new MutationObserver(() => schedule(true));
  mo.observe(el, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-selected', 'class'],
  });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(updateFades) : null;
  ro?.observe(el);
  el.addEventListener('scroll', updateFades, { passive: true });

  return () => {
    cancelAnimationFrame(raf);
    mo.disconnect();
    ro?.disconnect();
    el.removeEventListener('scroll', updateFades);
  };
}

interface AlpineDirectiveHost {
  directive(
    name: string,
    cb: (el: Element, binding: unknown, utils: { cleanup: (fn: () => void) => void }) => void,
  ): void;
}

export function registerChipScrollDirective(Alpine: AlpineDirectiveHost): void {
  Alpine.directive('chip-scroll', (el, _binding, { cleanup }) => {
    cleanup(bindChipScroll(el as HTMLElement));
  });
}
