/**
 * Directives chargées à la demande (x-scrub, x-swipe, x-hold) : le stub importe
 * le module puis branche l'élément ; un élément retiré avant la fin du chargement
 * n'est jamais branché ; le nettoyage de l'élément débranche le geste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { scrubDispose, bindChartScrub, bindSwipe, bindHoldRepeat } = vi.hoisted(() => {
  const scrubDispose = vi.fn();
  const swipeDispose = vi.fn();
  const holdDispose = vi.fn();
  return {
    scrubDispose,
    swipeDispose,
    holdDispose,
    bindChartScrub: vi.fn((_el: unknown, _read: () => unknown) => scrubDispose),
    bindSwipe: vi.fn((_el: unknown, _dir: string, _run: () => Promise<unknown>) => swipeDispose),
    bindHoldRepeat: vi.fn((_el: unknown, _step: () => void) => holdDispose),
  };
});

vi.mock('../../apps/web/src/lib/chart-scrub.js', () => ({ bindChartScrub }));
vi.mock('../../apps/web/src/lib/swipe-row.js', () => ({ bindSwipe }));
vi.mock('../../apps/web/src/lib/hold-repeat.js', () => ({ bindHoldRepeat }));

import { registerLazyDirectives } from '../../apps/web/src/lib/lazy-directives.js';

type Handler = (
  el: Element,
  binding: { expression: string; value: string },
  utils: {
    evaluateLater: (expr: string) => (cb?: (value: unknown) => void) => void;
    cleanup: (fn: () => void) => void;
  },
) => void;

function setup() {
  const handlers: Record<string, Handler> = {};
  registerLazyDirectives({
    directive: (name, cb) => {
      handlers[name] = cb as Handler;
    },
  });
  return handlers;
}

function utils(result: unknown = 'ok') {
  const cleanups: Array<() => void> = [];
  const evaluated: string[] = [];
  return {
    cleanups,
    evaluated,
    u: {
      evaluateLater: (expr: string) => (cb?: (value: unknown) => void) => {
        evaluated.push(expr);
        cb?.(result);
      },
      cleanup: (fn: () => void) => cleanups.push(fn),
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const el = {} as Element;

describe('directives à la demande', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enregistre scrub, swipe et hold', () => {
    expect(Object.keys(setup()).sort()).toEqual(['hold', 'scrub', 'swipe']);
  });

  it('x-scrub : branche la courbe et lit la géométrie à la demande', async () => {
    const h = setup();
    const { u, cleanups } = utils({ w: 1 });
    h.scrub!(el, { expression: 'chartScrub()', value: '' }, u);
    await flush();
    expect(bindChartScrub).toHaveBeenCalledTimes(1);
    const read = bindChartScrub.mock.calls[0]![1];
    expect(read()).toEqual({ w: 1 });
    cleanups.forEach((f) => f());
    expect(scrubDispose).toHaveBeenCalled();
  });

  it('x-swipe : un sens inconnu est ignoré, l’action attend le résultat', async () => {
    const h = setup();
    const a = utils();
    h.swipe!(el, { expression: 'x()', value: 'up' }, a.u);
    await flush();
    expect(bindSwipe).not.toHaveBeenCalled();

    const b = utils('fait');
    h.swipe!(el, { expression: 'remove(id)', value: 'left' }, b.u);
    await flush();
    expect(bindSwipe).toHaveBeenCalledWith(el, 'left', expect.any(Function));
    await expect(bindSwipe.mock.calls[0]![2]()).resolves.toBe('fait');
    expect(b.evaluated).toEqual(['remove(id)']);
  });

  it('x-hold : élément retiré avant le chargement → jamais branché', async () => {
    const h = setup();
    const { u, cleanups } = utils();
    h.hold!(el, { expression: 'bumpWeight(1)', value: '' }, u);
    cleanups.forEach((f) => f());
    await flush();
    expect(bindHoldRepeat).not.toHaveBeenCalled();
  });

  it('x-hold : chaque pas exécute l’expression', async () => {
    const h = setup();
    const { u, evaluated } = utils();
    h.hold!(el, { expression: 'bumpReps(1)', value: '' }, u);
    await flush();
    bindHoldRepeat.mock.calls[0]![1]();
    bindHoldRepeat.mock.calls[0]![1]();
    expect(evaluated).toEqual(['bumpReps(1)', 'bumpReps(1)']);
  });
});
