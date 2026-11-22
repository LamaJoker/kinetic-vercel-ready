/**
 * x-chip-scroll : une rangée d'onglets cachée au chargement (x-show, largeur
 * nulle) amène l'onglet actif à l'écran dès qu'elle s'affiche
 * (/progression?tab=compare → « Comparer » visible).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bindChipScroll } from '../../apps/web/src/lib/chip-scroll.js';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let roCb: (() => void) | null = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCb = cb;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => {
    f();
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('getComputedStyle', () => ({ position: 'relative' }));
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });

  const active = { offsetLeft: 420, offsetWidth: 90 };
  const scrolls: number[] = [];
  const el = {
    clientWidth: 0, // caché (x-show)
    scrollWidth: 520,
    scrollLeft: 0,
    style: {},
    querySelector: () => active,
    scrollTo: ({ left }: { left: number }) => {
      scrolls.push(left);
      el.scrollLeft = left;
    },
    toggleAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  bindChipScroll(el as unknown as HTMLElement);
  return { el, scrolls, resize: () => roCb!() };
}

describe('rangée d’onglets affichée après coup', () => {
  it('cachée au chargement : l’onglet actif est amené à l’écran quand elle s’affiche', () => {
    const { el, scrolls, resize } = setup();
    expect(scrolls).toEqual([]); // largeur nulle : rien à faire
    el.clientWidth = 360; // x-show → affichée
    resize();
    expect(scrolls).toEqual([160]); // 420 + 90 + 24 − 360, borné à 520 − 360
  });

  it('une fois révélée, un redimensionnement ne refait pas défiler', () => {
    const { el, scrolls, resize } = setup();
    el.clientWidth = 360;
    resize();
    el.scrollLeft = 0; // l'utilisateur a fait défiler à la main
    resize();
    expect(scrolls).toEqual([160]);
  });
});
