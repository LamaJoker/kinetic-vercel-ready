import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn().mockResolvedValue({
    storage: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
    },
  }),
}));

import {
  nearestIndex,
  clampBubbleLeft,
  isScrubData,
  bindChartScrub,
  type ScrubData,
} from '../../apps/web/src/lib/chart-scrub.js';
import { bodyweight, bodyweightChartGeometry } from '../../apps/web/src/pages/bodyweight.page.js';
import {
  mensurations,
  mensurationsChartGeometry,
} from '../../apps/web/src/pages/mensurations.page.js';
import { forceChartGeometry } from '../../apps/web/src/pages/progression.page.js';

describe('parcours au doigt : logique pure', () => {
  it('point le plus proche (recherche dichotomique)', () => {
    const xs = [0, 10, 20, 50];
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 4)).toBe(0);
    expect(nearestIndex(xs, 6)).toBe(1);
    expect(nearestIndex(xs, 34)).toBe(2);
    expect(nearestIndex(xs, 36)).toBe(3);
    expect(nearestIndex(xs, 999)).toBe(3);
    expect(nearestIndex([], 3)).toBe(-1);
    expect(nearestIndex([7], 3)).toBe(0);
  });

  it('bulle centrée sur le point, jamais hors du cadre', () => {
    expect(clampBubbleLeft(100, 80, 300)).toBe(60);
    expect(clampBubbleLeft(10, 80, 300)).toBe(0);
    expect(clampBubbleLeft(295, 80, 300)).toBe(220);
  });

  it('données valides seulement avec des points', () => {
    expect(isScrubData(null)).toBe(false);
    expect(isScrubData({ w: 320, h: 100, points: [] })).toBe(false);
    expect(isScrubData({ w: 320, h: 100, points: [{ x: 1, y: 1, label: '', value: '' }] })).toBe(
      true,
    );
  });
});

describe('parcours au doigt : courbes des pages', () => {
  it('poids : un point par pesée, aligné sur le tracé, valeur en français', () => {
    const page = bodyweight();
    page.period = 9999;
    page.entries = [
      { date: '2026-10-01', weight: 80.4, bodyFatPct: null, note: null },
      { date: '2026-10-08', weight: 79.6, bodyFatPct: null, note: null },
      { date: '2026-10-15', weight: 79.1, bodyFatPct: null, note: null },
    ];
    const d = page.chartScrub()!;
    expect(d.w).toBe(320);
    expect(d.points).toHaveLength(3);
    expect(d.points[1]!.value).toBe('79,6 kg');
    const g = bodyweightChartGeometry(page.filteredEntries, null);
    expect(d.points.map((p) => p.x)).toEqual(g.coords.map((c) => c[0]));
    expect(d.points[0]!.x).toBeLessThan(d.points[2]!.x);
    // le tracé utilise la même géométrie
    expect(page.chartSvg()).toContain(`cx="${g.coords[2]![0].toFixed(1)}"`);
  });

  it('poids : rien à parcourir sous deux pesées', () => {
    const page = bodyweight();
    page.entries = [{ date: '2026-10-01', weight: 80, bodyFatPct: null, note: null }];
    expect(page.chartScrub()).toBeNull();
  });

  it('mensurations : points dans le viewBox, valeur en cm', () => {
    const page = mensurations();
    page.entries = [
      { id: 'a', date: '2026-09-01', waist: 84.5 },
      { id: 'b', date: '2026-10-01', waist: 83 },
    ] as never;
    page.activeMetric = 'waist';
    page.period = 9999;
    const d = page.chartScrub()!;
    expect(d.points[0]!.label).toMatch(/sept\. 2026/);
    expect(d.points.map((p) => p.value)).toEqual(['84,5 cm', '83 cm']);
  });

  it('géométries partagées : bornes du viewBox respectées', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 1000, y: 110 },
      { x: 2000, y: 105 },
    ];
    for (const g of [mensurationsChartGeometry(pts), forceChartGeometry(pts)]) {
      for (const p of pts) {
        expect(g.sx(p.x)).toBeGreaterThanOrEqual(0);
        expect(g.sx(p.x)).toBeLessThanOrEqual(g.W);
        expect(g.sy(p.y)).toBeGreaterThanOrEqual(0);
        expect(g.sy(p.y)).toBeLessThanOrEqual(g.H);
      }
    }
  });
});

// ─── Branchement (faux DOM minimal) ─────────────────────────────────────────

class FakeEl extends EventTarget {
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  classes = new Set<string>();
  offsetWidth = 60;
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
  };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  remove() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 320, height: 160 } as DOMRect;
  }
  querySelector() {
    return this; // le « svg » occupe tout l'hôte
  }
}

function ptr(type: string, clientX: number, pointerId = 1) {
  return Object.assign(new Event(type), {
    pointerId,
    clientX,
    clientY: 50,
    pointerType: 'touch',
    button: 0,
  });
}

describe('parcours au doigt : branchement', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => new FakeEl() });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0); // image immédiate (synchrone) : aucune image en attente ensuite
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  it('le curseur suit le doigt, la bulle montre le point, relâcher masque', () => {
    const host = new FakeEl();
    const data: ScrubData = {
      w: 320,
      h: 160,
      points: [
        { x: 10, y: 100, label: '1 oct.', value: '80 kg' },
        { x: 300, y: 50, label: '8 oct.', value: '79 kg' },
      ],
    };
    const off = bindChartScrub(host as unknown as HTMLElement, () => data);
    expect(host.attrs['data-k-noswipe']).toBe('');
    host.dispatchEvent(ptr('pointerdown', 20));
    expect(host.classes.has('is-scrubbing')).toBe(true);
    const layer = host.children[0]!;
    const bubble = layer.children[2]!;
    expect(bubble.children[0]!.textContent).toBe('1 oct.');
    host.dispatchEvent(ptr('pointermove', 290));
    expect(bubble.children[1]!.textContent).toBe('79 kg');
    host.dispatchEvent(ptr('pointerup', 290));
    expect(host.classes.has('is-scrubbing')).toBe(false);
    off();
  });

  it('sans données (moins de deux points) : rien ne s’affiche', () => {
    const host = new FakeEl();
    bindChartScrub(host as unknown as HTMLElement, () => null);
    host.dispatchEvent(ptr('pointerdown', 20));
    expect(host.classes.has('is-scrubbing')).toBe(false);
    expect(host.children).toHaveLength(0);
  });
});
