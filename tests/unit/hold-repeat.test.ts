import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  holdInterval,
  bindHoldRepeat,
  HOLD_DELAY_MS,
  HOLD_MIN_INTERVAL_MS,
  HOLD_FIRST_INTERVAL_MS,
  HOLD_MAX_REPEATS,
} from '../../apps/web/src/lib/hold-repeat.js';

describe('appui maintenu : rythme', () => {
  it('accélère puis plafonne', () => {
    expect(holdInterval(0)).toBe(HOLD_FIRST_INTERVAL_MS);
    expect(holdInterval(3)).toBeLessThan(holdInterval(1));
    expect(holdInterval(100)).toBe(HOLD_MIN_INTERVAL_MS);
  });
});

class FakeBtn extends EventTarget {
  disabled = false;
  classes = new Set<string>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
  };
}

const ptr = (type: string, x = 0, y = 0) =>
  Object.assign(new Event(type), {
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
  });
const click = (detail: number) => Object.assign(new Event('click'), { detail });

describe('appui maintenu : branchement', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('toucher bref : une seule exécution, au relâcher (le clic qui suit est ignoré)', () => {
    const btn = new FakeBtn();
    const step = vi.fn();
    bindHoldRepeat(btn as unknown as HTMLElement, step);
    btn.dispatchEvent(ptr('pointerdown'));
    expect(step).not.toHaveBeenCalled();
    btn.dispatchEvent(ptr('pointerup'));
    btn.dispatchEvent(click(1));
    expect(step).toHaveBeenCalledOnce();
  });

  it('appui maintenu : répétitions de plus en plus rapides, arrêt au relâcher', () => {
    const btn = new FakeBtn();
    const step = vi.fn();
    bindHoldRepeat(btn as unknown as HTMLElement, step);
    btn.dispatchEvent(ptr('pointerdown'));
    vi.advanceTimersByTime(HOLD_DELAY_MS);
    expect(step).toHaveBeenCalledTimes(1);
    expect(btn.classes.has('is-holding')).toBe(true);
    vi.advanceTimersByTime(1500);
    const n = step.mock.calls.length;
    expect(n).toBeGreaterThan(10); // accéléré : bien plus que 1500 / 170
    btn.dispatchEvent(ptr('pointerup'));
    vi.advanceTimersByTime(1000);
    expect(step).toHaveBeenCalledTimes(n); // pas d'exécution de plus au relâcher
    expect(btn.classes.has('is-holding')).toBe(false);
  });

  it('défilement (doigt qui bouge) ou annulation : rien', () => {
    const btn = new FakeBtn();
    const step = vi.fn();
    bindHoldRepeat(btn as unknown as HTMLElement, step);
    btn.dispatchEvent(ptr('pointerdown', 0, 0));
    btn.dispatchEvent(ptr('pointermove', 0, 30));
    btn.dispatchEvent(ptr('pointerup', 0, 30));
    btn.dispatchEvent(ptr('pointerdown'));
    btn.dispatchEvent(ptr('pointercancel'));
    vi.advanceTimersByTime(2000);
    expect(step).not.toHaveBeenCalled();
  });

  it('clavier (clic sans pointeur) : une exécution', () => {
    const btn = new FakeBtn();
    const step = vi.fn();
    bindHoldRepeat(btn as unknown as HTMLElement, step);
    btn.dispatchEvent(click(0));
    expect(step).toHaveBeenCalledOnce();
  });

  it('nettoyage : plus aucun écouteur', () => {
    const btn = new FakeBtn();
    const step = vi.fn();
    const off = bindHoldRepeat(btn as unknown as HTMLElement, step);
    off();
    btn.dispatchEvent(ptr('pointerdown'));
    btn.dispatchEvent(ptr('pointerup'));
    btn.dispatchEvent(click(0));
    expect(step).not.toHaveBeenCalled();
  });

  it('relâcher hors du bouton : la répétition s’arrête quand même', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    try {
      const btn = new FakeBtn();
      const step = vi.fn();
      bindHoldRepeat(btn as unknown as HTMLElement, step);
      btn.dispatchEvent(ptr('pointerdown'));
      vi.advanceTimersByTime(HOLD_DELAY_MS + 500);
      const n = step.mock.calls.length;
      win.dispatchEvent(ptr('pointerup')); // reçu par la fenêtre, pas par le bouton
      vi.advanceTimersByTime(2000);
      expect(step).toHaveBeenCalledTimes(n);
      expect(btn.classes.has('is-holding')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bouton retiré, désactivé ou appui interminable : arrêt automatique', () => {
    const btn = Object.assign(new FakeBtn(), { isConnected: true });
    const step = vi.fn();
    bindHoldRepeat(btn as unknown as HTMLElement, step);
    btn.dispatchEvent(ptr('pointerdown'));
    vi.advanceTimersByTime(HOLD_DELAY_MS + 300);
    btn.isConnected = false;
    const n = step.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(step).toHaveBeenCalledTimes(n);

    const btn2 = new FakeBtn();
    const step2 = vi.fn();
    bindHoldRepeat(btn2 as unknown as HTMLElement, step2);
    btn2.dispatchEvent(ptr('pointerdown'));
    vi.advanceTimersByTime(60_000);
    expect(step2).toHaveBeenCalledTimes(HOLD_MAX_REPEATS);
  });
});
