import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  commitDistance,
  swipeOffset,
  swipeCommit,
  bindSwipe,
  SWIPE_OUT_MS,
} from '../../apps/web/src/lib/swipe-row.js';

const BOTH = { left: true, right: true };

describe('ligne à glisser : logique pure', () => {
  it('seuil : 35 % de la largeur, borné', () => {
    expect(commitDistance(300)).toBe(105);
    expect(commitDistance(100)).toBe(56);
    expect(commitDistance(1000)).toBe(140);
  });

  it('suit le doigt jusqu’au seuil, puis résiste (élastique)', () => {
    expect(swipeOffset(50, 100, BOTH)).toBe(50);
    expect(swipeOffset(-100, 100, BOTH)).toBe(-100);
    const far = swipeOffset(300, 100, BOTH);
    expect(far).toBeGreaterThan(100);
    expect(far).toBeLessThan(300);
    expect(swipeOffset(-300, 100, BOTH)).toBe(-far);
  });

  it('sens désactivé : la ligne ne bouge pas', () => {
    expect(swipeOffset(80, 100, { left: true, right: false })).toBe(0);
    expect(swipeOffset(-80, 100, { left: false, right: true })).toBe(0);
  });

  it('validation : seuil franchi ou lancer rapide dans le même sens', () => {
    expect(swipeCommit(110, 0, 100)).toBe('right');
    expect(swipeCommit(-110, 0, 100)).toBe('left');
    expect(swipeCommit(60, 0.1, 100)).toBeNull();
    expect(swipeCommit(60, 0.9, 100)).toBe('right');
    expect(swipeCommit(-60, -0.9, 100)).toBe('left');
    expect(swipeCommit(60, -0.9, 100)).toBeNull();
    expect(swipeCommit(0, 2, 100)).toBeNull();
  });
});

// ─── Branchement (faux DOM minimal) ─────────────────────────────────────────

class FakeEl extends EventTarget {
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  style = {
    transform: '',
    vars: {} as Record<string, string>,
    setProperty(k: string, v: string) {
      this.vars[k] = v;
    },
  };
  isConnected = true;
  child: FakeEl | null = null;
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
    toggle: (c: string, on: boolean) => void (on ? this.classes.add(c) : this.classes.delete(c)),
  };
  get firstElementChild() {
    return this.child;
  }
  querySelector() {
    return this.child;
  }
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 300, height: 56 } as DOMRect;
  }
}

let t = 0;
function ptr(type: string, clientX: number, clientY = 100) {
  t += 16;
  const e = Object.assign(new Event(type), {
    pointerId: 1,
    clientX,
    clientY,
    pointerType: 'touch',
    button: 0,
  });
  Object.defineProperty(e, 'timeStamp', { value: t });
  return e;
}

function makeRow() {
  const host = new FakeEl();
  host.child = new FakeEl();
  return host;
}

function drag(host: FakeEl, path: Array<[number, number]>) {
  const [x0, y0] = path[0]!;
  host.dispatchEvent(ptr('pointerdown', x0, y0));
  for (const [x, y] of path.slice(1)) host.dispatchEvent(ptr('pointermove', x, y));
  const [xe, ye] = path.at(-1)!;
  host.dispatchEvent(ptr('pointerup', xe, ye));
}

describe('ligne à glisser : branchement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('vers la droite au-delà du seuil : action, puis retour en place', async () => {
    const host = makeRow();
    const right = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'right', right);
    drag(host, [
      [100, 100],
      [130, 102],
      [200, 104],
      [240, 104],
    ]);
    await vi.runAllTimersAsync();
    expect(right).toHaveBeenCalledOnce();
    expect(host.child!.style.transform).toBe('');
  });

  it('pas assez loin : retour élastique, aucune action', async () => {
    const host = makeRow();
    const right = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'right', right);
    // mouvement lent : pas de lancer
    host.dispatchEvent(ptr('pointerdown', 100));
    t += 500;
    host.dispatchEvent(ptr('pointermove', 115));
    t += 500;
    host.dispatchEvent(ptr('pointermove', 130));
    t += 500;
    host.dispatchEvent(ptr('pointerup', 130));
    await vi.runAllTimersAsync();
    expect(right).not.toHaveBeenCalled();
    expect(host.child!.style.transform).toBe('');
  });

  it('vers la gauche : la ligne sort, puis l’action', async () => {
    const host = makeRow();
    const left = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'left', left);
    drag(host, [
      [250, 100],
      [220, 100],
      [150, 100],
      [100, 100],
    ]);
    expect(host.child!.style.transform).toContain('-300');
    expect(left).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS);
    expect(left).toHaveBeenCalledOnce();
  });

  it('défilement vertical : jamais de glissement', async () => {
    const host = makeRow();
    const left = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'left', left);
    drag(host, [
      [250, 100],
      [245, 140],
      [100, 300],
    ]);
    await vi.runAllTimersAsync();
    expect(left).not.toHaveBeenCalled();
    expect(host.child!.style.transform).toBe('');
  });

  it('sens désactivé (data-swipe-left="off") : rien', async () => {
    const host = makeRow();
    host.dataset.swipeLeft = 'off';
    const left = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'left', left);
    drag(host, [
      [250, 100],
      [200, 100],
      [60, 100],
    ]);
    await vi.runAllTimersAsync();
    expect(left).not.toHaveBeenCalled();
  });

  it('départ au bord gauche : laissé au retour par le bord', async () => {
    const host = makeRow();
    const right = vi.fn();
    bindSwipe(host as unknown as HTMLElement, 'right', right);
    drag(host, [
      [8, 100],
      [60, 100],
      [250, 100],
    ]);
    await vi.runAllTimersAsync();
    expect(right).not.toHaveBeenCalled();
  });
});
