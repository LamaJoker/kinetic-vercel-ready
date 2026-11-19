/**
 * Menu contextuel par appui long (façon iOS) — chargé par native-ui.ts.
 *
 * Dans une page : un élément porte `data-k-menu` et écoute l'événement `k-menu`,
 * dont le détail fournit `show(actions)` (une seule expression, compatible CSP) :
 *   <div data-k-menu @k-menu="sessionMenu($event.detail, s.id)">…</div>
 *   sessionMenu(menu: ContextMenuRequest, id: string) {
 *     menu.show([{ label: 'Dupliquer', icon: 'copy', run: () => … }]);
 *   }
 *
 * Déclenchement : appui long de LONG_PRESS_MS sans bouger (doigt / stylet), ou
 * clic droit / « contextmenu » (souris, Android). Jamais pendant un défilement :
 * le défilement annule l'appui (pointercancel, mouvement > LONG_PRESS_SLOP_PX,
 * ou événement scroll). Le clic qui suit l'appui long est absorbé.
 *
 * Affichage : vibration légère, fond flouté, copie de l'élément mise en avant
 * (léger zoom), menu en verre dessous (ou dessus faute de place). Une action
 * avec `confirm` demande une seconde touche (bouton rouge) avant d'agir.
 * Clavier : flèches, Entrée, Échap ; le focus revient sur l'élément.
 */
import { hapticTap } from './haptics';
import { inertClone } from './page-layers';
import { prefersReducedMotion } from './nav-motion';

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;

export type ContextMenuIcon = 'copy' | 'share' | 'trash' | 'edit' | 'play' | 'plus' | 'link';

export type ContextMenuAction = {
  label: string;
  icon?: ContextMenuIcon;
  /** Action destructive (texte rouge). */
  danger?: boolean;
  /** Libellé du bouton de confirmation : l'action demande une seconde touche. */
  confirm?: string;
  run: () => unknown;
};

export type ContextMenuRequest = { show(actions: ContextMenuAction[]): void };

// ─── Détection de l'appui long (logique pure, testée) ──────────────────────

type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
};

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Appui long : start → (move)* → fire après `ms` si le doigt n'a pas bougé de plus de `slop`. */
export class LongPress {
  private timer: unknown = null;
  private x = 0;
  private y = 0;
  fired = false;

  constructor(
    private readonly onFire: () => void,
    private readonly ms = LONG_PRESS_MS,
    private readonly slop = LONG_PRESS_SLOP_PX,
    private readonly timers: Timers = defaultTimers,
  ) {}

  get pending(): boolean {
    return this.timer !== null;
  }

  start(x: number, y: number): void {
    this.cancel();
    this.fired = false;
    this.x = x;
    this.y = y;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fired = true;
      this.onFire();
    }, this.ms);
  }

  /** Retourne false si le mouvement a annulé l'appui. */
  move(x: number, y: number): boolean {
    if (this.timer === null) return !this.fired;
    if (Math.hypot(x - this.x, y - this.y) > this.slop) {
      this.cancel();
      return false;
    }
    return true;
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

/** Placement du menu sous (ou au-dessus de) l'élément, sans sortir de l'écran. */
export function placeMenu(o: {
  top: number;
  bottom: number;
  menuHeight: number;
  viewport: number;
  safeTop?: number;
  safeBottom?: number;
  gap?: number;
}): { menuTop: number; shift: number } {
  const gap = o.gap ?? 10;
  const minTop = (o.safeTop ?? 0) + 8;
  const maxBottom = o.viewport - (o.safeBottom ?? 0) - 12;
  // 1. Dessous, tel quel.
  if (o.bottom + gap + o.menuHeight <= maxBottom) return { menuTop: o.bottom + gap, shift: 0 };
  // 2. Dessus, tel quel.
  if (o.top - gap - o.menuHeight >= minTop)
    return { menuTop: o.top - gap - o.menuHeight, shift: 0 };
  // 3. Dessous, en remontant l'élément autant que possible.
  const menuTop = Math.max(minTop, maxBottom - o.menuHeight);
  const wanted = menuTop - gap - o.bottom; // négatif : on remonte
  const shift = Math.max(wanted, minTop - o.top);
  return { menuTop, shift: Math.min(0, shift) };
}

// ─── Affichage ─────────────────────────────────────────────────────────────

const ICONS: Record<ContextMenuIcon, string> = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  share:
    '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/>',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
};

function icon(name?: ContextMenuIcon): string {
  if (!name) return '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

let openMenu: { close: (run?: () => unknown) => void } | null = null;

function safeInset(side: 'top' | 'bottom'): number {
  const v = parseFloat(
    getComputedStyle(document.body)[side === 'top' ? 'paddingTop' : 'paddingBottom'],
  );
  return Number.isFinite(v) ? v : 0;
}

/** Ouvre le menu pour `anchor`. */
export function showContextMenu(anchor: HTMLElement, actions: ContextMenuAction[]): void {
  if (!actions.length) return;
  openMenu?.close();
  hapticTap();
  const reduced = prefersReducedMotion();
  const box = anchor.getBoundingClientRect();
  // Aperçu limité à la moitié de l'écran, jamais sous la barre d'état.
  const height = Math.min(box.height, window.innerHeight * 0.5);
  const top = Math.max(box.top, safeInset('top') + 8);
  const rect = {
    left: box.left,
    right: box.right,
    width: box.width,
    top,
    bottom: top + height,
    height,
  };
  const returnFocus = document.activeElement as HTMLElement | null;

  const root = document.createElement('div');
  root.className = 'k-cm';
  const backdrop = document.createElement('div');
  backdrop.className = 'k-cm-backdrop';
  const preview = document.createElement('div');
  preview.className = 'k-cm-preview';
  preview.setAttribute('aria-hidden', 'true');
  const copy = inertClone(anchor);
  preview.appendChild(copy);
  Object.assign(preview.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const menu = document.createElement('div');
  menu.className = 'k-cm-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions');
  root.append(backdrop, preview, menu);

  const render = (list: ContextMenuAction[]): void => {
    menu.textContent = '';
    for (const a of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'k-cm-item' + (a.danger ? ' is-danger' : '');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span></span>${icon(a.icon)}`;
      (b.firstChild as HTMLElement).textContent = a.label;
      b.addEventListener('click', () => {
        if (a.confirm) {
          hapticTap();
          render([
            { label: a.confirm, danger: true, run: a.run, ...(a.icon ? { icon: a.icon } : {}) },
            { label: 'Annuler', run: () => undefined },
          ]);
          return;
        }
        close(a.run);
      });
      menu.appendChild(b);
    }
    menu.querySelector<HTMLElement>('.k-cm-item')?.focus({ preventScroll: true });
  };
  render(actions);
  document.body.appendChild(root);

  // Placement (le menu est mesuré une fois inséré).
  const vw = window.innerWidth;
  const menuW = Math.min(250, vw - 32);
  menu.style.width = `${menuW}px`;
  const { menuTop, shift } = placeMenu({
    top: rect.top,
    bottom: rect.bottom,
    menuHeight: menu.offsetHeight,
    viewport: window.innerHeight,
    safeTop: safeInset('top'),
    safeBottom: safeInset('bottom'),
  });
  const alignRight = rect.left + rect.width / 2 > vw / 2;
  const left = alignRight
    ? Math.max(16, Math.min(vw - 16, rect.right) - menuW)
    : Math.min(vw - 16 - menuW, Math.max(16, rect.left));
  menu.style.left = `${left}px`;
  menu.style.top = `${menuTop}px`;
  menu.style.transformOrigin = `${alignRight ? 'right' : 'left'} ${menuTop < rect.top ? 'bottom' : 'top'}`;
  preview.style.setProperty('--k-cm-shift', `${shift}px`);

  if (!reduced) void root.offsetWidth;
  root.classList.add('is-open');

  let closed = false;
  function close(run?: () => unknown): void {
    if (closed) return;
    closed = true;
    openMenu = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), reduced ? 0 : 220);
    if (returnFocus?.isConnected) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    if (run) {
      // Après la fermeture visuelle : l'action peut ouvrir une feuille, naviguer…
      setTimeout(
        () => {
          try {
            void Promise.resolve(run()).catch((err) => console.warn('[menu] action failed:', err));
          } catch (err) {
            console.warn('[menu] action failed:', err);
          }
        },
        reduced ? 0 : 120,
      );
    }
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.k-cm-item'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    items[(next + items.length) % items.length]?.focus();
  }
  const onResize = (): void => close();
  backdrop.addEventListener('click', () => close());
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  openMenu = { close };
}

/** Demande les actions à la page (événement `k-menu`) puis ouvre le menu. */
function request(el: HTMLElement): boolean {
  let shown = false;
  const detail: ContextMenuRequest = {
    show(actions) {
      if (shown) return;
      shown = true;
      showContextMenu(el, actions);
    },
  };
  el.dispatchEvent(new CustomEvent('k-menu', { detail }));
  return shown;
}

// ─── Branchement global ────────────────────────────────────────────────────

let started = false;

export function initContextMenu(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  let target: HTMLElement | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let swallowNext = false;
  let swallowUntil = 0;

  const unpress = (): void => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    target?.classList.remove('k-cm-pressing');
  };

  const lp = new LongPress(() => {
    const el = target;
    unpress();
    if (!el?.isConnected) return;
    if (request(el)) swallowNext = true;
  });

  const cancel = (): void => {
    lp.cancel();
    unpress();
    target = null;
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-k-menu]');
      if (!el) return;
      target = el;
      lp.start(e.clientX, e.clientY);
      // Léger enfoncement, seulement si le doigt reste (pas sur un simple toucher).
      pressTimer = setTimeout(() => el.classList.add('k-cm-pressing'), 150);
    },
    { passive: true },
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (target && !lp.move(e.clientX, e.clientY)) cancel();
    },
    { passive: true },
  );
  document.addEventListener(
    'pointerup',
    () => {
      // Le clic synthétique du relâcher suit immédiatement : on l'absorbe.
      if (swallowNext) swallowUntil = Date.now() + 400;
      swallowNext = false;
      cancel();
    },
    { passive: true },
  );
  document.addEventListener('pointercancel', () => cancel(), { passive: true });
  window.addEventListener('scroll', () => target && cancel(), { passive: true, capture: true });

  // Clic droit (souris) ou appui long Android : même menu, sans menu du navigateur.
  document.addEventListener('contextmenu', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-k-menu]');
    if (!el) return;
    e.preventDefault();
    if (openMenu) return; // l'appui long l'a déjà ouvert
    cancel();
    request(el);
  });

  // Le clic qui suit l'appui long ne doit pas ouvrir / déplier l'élément.
  document.addEventListener(
    'click',
    (e) => {
      if (Date.now() < swallowUntil) {
        e.preventDefault();
        e.stopPropagation();
        swallowUntil = 0;
      }
    },
    { capture: true },
  );
}
