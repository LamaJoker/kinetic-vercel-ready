import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false), getPlatform: vi.fn(() => 'web') },
}));

import {
  largeTitleProgress,
  snapProgress,
  TITLE_FADE_RANGE_PX,
} from '../../apps/web/src/lib/large-title.js';
import { shouldDismissSheet, recedeScaleFor, RECEDE_SCALE } from '../../apps/web/src/lib/sheets.js';
import {
  LongPress,
  placeMenu,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
} from '../../apps/web/src/lib/context-menu.js';
import { ghostOffset, GHOST_PARALLAX } from '../../apps/web/src/lib/native-gestures.js';
import { pageLayers, sharedOrigin } from '../../apps/web/src/lib/page-layers.js';
import {
  rememberPath,
  pathAt,
  enableSnapshots,
  snapshotsEnabled,
  storeSnapshot,
  getSnapshot,
} from '../../apps/web/src/lib/nav-motion.js';

describe('grand titre réductible', () => {
  it('reste caché tant que le titre est bien sous la barre', () => {
    expect(largeTitleProgress(200, 91)).toBe(0);
    expect(largeTitleProgress(91 + TITLE_FADE_RANGE_PX, 91)).toBe(0);
  });
  it('progresse linéairement sur la course puis plafonne à 1', () => {
    expect(largeTitleProgress(91 + TITLE_FADE_RANGE_PX / 2, 91)).toBeCloseTo(0.5);
    expect(largeTitleProgress(91, 91)).toBe(1);
    expect(largeTitleProgress(-40, 91)).toBe(1);
  });
  it('course nulle : tout ou rien', () => {
    expect(largeTitleProgress(90, 91, 0)).toBe(1);
    expect(largeTitleProgress(92, 91, 0)).toBe(0);
  });
  it('mouvement réduit : arrondi à 0 ou 1', () => {
    expect(snapProgress(0.49)).toBe(0);
    expect(snapProgress(0.5)).toBe(1);
  });
});

describe('feuilles à glisser', () => {
  it('ne ferme pas vers le haut ni sur un petit glissé lent', () => {
    expect(shouldDismissSheet(0, 2, 600)).toBe(false);
    expect(shouldDismissSheet(-50, 2, 600)).toBe(false);
    expect(shouldDismissSheet(60, 0.1, 600)).toBe(false);
  });
  it('ferme au-delà d’un tiers de la hauteur (220 px au plus)', () => {
    expect(shouldDismissSheet(100, 0, 300)).toBe(true);
    expect(shouldDismissSheet(99, 0, 300)).toBe(false);
    expect(shouldDismissSheet(220, 0, 900)).toBe(true);
    expect(shouldDismissSheet(219, 0, 900)).toBe(false);
  });
  it('ferme sur un lancer rapide, même court (24 px minimum)', () => {
    expect(shouldDismissSheet(30, 0.8, 600)).toBe(true);
    expect(shouldDismissSheet(20, 2, 600)).toBe(false);
  });
  it('l’écran derrière revient de 0,94 à 1 en suivant la feuille', () => {
    expect(recedeScaleFor(0, 500)).toBe(RECEDE_SCALE);
    expect(recedeScaleFor(250, 500)).toBeCloseTo((RECEDE_SCALE + 1) / 2);
    expect(recedeScaleFor(800, 500)).toBe(1);
    expect(recedeScaleFor(50, 0)).toBe(RECEDE_SCALE);
  });
});

describe('appui long', () => {
  afterEach(() => vi.useRealTimers());

  it('se déclenche après le délai sans mouvement', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const lp = new LongPress(fire);
    lp.start(10, 10);
    expect(lp.pending).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    expect(lp.move(10 + LONG_PRESS_SLOP_PX / 2, 10)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledOnce();
    expect(lp.fired).toBe(true);
    expect(lp.pending).toBe(false);
  });

  it('un mouvement au-delà de la tolérance (défilement) l’annule', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const lp = new LongPress(fire);
    lp.start(0, 0);
    expect(lp.move(0, LONG_PRESS_SLOP_PX + 1)).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(fire).not.toHaveBeenCalled();
    expect(lp.fired).toBe(false);
  });

  it('cancel() avant le délai : rien ne se passe ; un nouvel appui repart de zéro', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const lp = new LongPress(fire, 300, 5);
    lp.start(0, 0);
    vi.advanceTimersByTime(200);
    lp.cancel();
    lp.start(0, 0);
    vi.advanceTimersByTime(200);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fire).toHaveBeenCalledOnce();
  });
});

describe('placement du menu contextuel', () => {
  it('sous l’élément quand il y a la place', () => {
    expect(placeMenu({ top: 100, bottom: 180, menuHeight: 150, viewport: 800 })).toEqual({
      menuTop: 190,
      shift: 0,
    });
  });
  it('au-dessus faute de place dessous', () => {
    expect(placeMenu({ top: 600, bottom: 700, menuHeight: 150, viewport: 800 })).toEqual({
      menuTop: 440,
      shift: 0,
    });
  });
  it('sinon dessous, en remontant l’élément sans passer sous la barre d’état', () => {
    const r = placeMenu({
      top: 100,
      bottom: 500,
      menuHeight: 400,
      viewport: 800,
      safeTop: 40,
    });
    expect(r.menuTop).toBe(388); // 800 − 12 − 400
    expect(r.shift).toBeLessThan(0);
    expect(100 + r.shift).toBeGreaterThanOrEqual(48);
  });
});

describe('retour par le bord : écran précédent', () => {
  it('parallaxe de −30 % au départ, en place à la fin', () => {
    expect(ghostOffset(0, 400)).toBe(-GHOST_PARALLAX * 400);
    expect(ghostOffset(0.5, 400)).toBeCloseTo(-60);
    expect(ghostOffset(1, 400)).toBeCloseTo(0);
    expect(ghostOffset(2, 400)).toBeCloseTo(0);
    expect(ghostOffset(-1, 400)).toBe(-120);
  });

  it('mémorise les chemins et les copies (6 au plus, seulement si activé)', () => {
    rememberPath(3, '/seances/');
    expect(pathAt(3)).toBe('/seances'); // normalisé
    expect(pathAt(99)).toBeUndefined();
    const el = (n: number) => ({ n }) as unknown as HTMLElement;
    enableSnapshots(false);
    storeSnapshot('/a', el(0));
    expect(getSnapshot('/a')).toBeUndefined();
    enableSnapshots();
    expect(snapshotsEnabled()).toBe(true);
    for (let i = 0; i < 8; i++) storeSnapshot(`/p${i}`, el(i));
    expect(getSnapshot('/p0')).toBeUndefined();
    expect(getSnapshot('/p1')).toBeUndefined();
    expect(getSnapshot('/p7')).toEqual({ n: 7 });
    expect(getSnapshot('/p2')).toEqual({ n: 2 });
    enableSnapshots(false);
    expect(getSnapshot('/p7')).toBeUndefined();
  });
});

describe('calques de page', () => {
  class FakeEl {
    children: FakeEl[] = [];
    parent: FakeEl | null = null;
    constructor(
      readonly name: string,
      readonly fixed = false,
      readonly tagName = 'DIV',
    ) {}
    add(...kids: FakeEl[]): this {
      for (const k of kids) {
        k.parent = this;
        this.children.push(k);
      }
      return this;
    }
    contains(o: FakeEl): boolean {
      for (let n: FakeEl | null = o; n; n = n.parent) if (n === this) return true;
      return false;
    }
    querySelectorAll(): FakeEl[] {
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
  }

  it('découpe la page autour des éléments fixed', () => {
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeEl;
    const timer = new FakeEl('timer', true);
    const inner = new FakeEl('inner-fixed', true);
    timer.add(inner);
    const header = new FakeEl('header');
    const list = new FakeEl('list');
    const section = new FakeEl('section').add(list, timer);
    const tpl = new FakeEl('tpl', false, 'TEMPLATE');
    const page = new FakeEl('page').add(header, section, tpl);
    const root = new FakeEl('root').add(page);
    const { flow, fixed } = pageLayers(
      root as unknown as Element,
      (el) => (el as unknown as FakeEl).fixed,
    );
    expect(fixed.map((e) => (e as unknown as FakeEl).name)).toEqual(['timer']);
    expect(flow.map((e) => (e as unknown as FakeEl).name)).toEqual(['header', 'list']);
  });

  it('origine commune de réduction', () => {
    expect(sharedOrigin({ left: 10, top: 100 }, 200, 300)).toBe('190px 200px');
  });
});
