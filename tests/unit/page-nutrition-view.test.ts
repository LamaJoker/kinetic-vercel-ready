import { describe, it, expect, vi } from 'vitest';

vi.mock('alpinejs', () => ({ default: { store: () => undefined } }));
vi.mock('../../apps/web/src/lib/barcode-camera', () => ({
  cameraScanSupported: () => false,
  scanBarcodeWithCamera: vi.fn(),
}));

import {
  clampPct,
  ringVar,
  macroViews,
  MACRO_COLORS,
} from '../../apps/web/src/pages/nutrition.page.js';

describe('nutrition clampPct / ringVar', () => {
  it('bounds the percentage', () => {
    expect(clampPct(50, 200)).toBe(25);
    expect(clampPct(300, 200)).toBe(100);
    expect(clampPct(-5, 200)).toBe(0);
    expect(clampPct(10, 0)).toBe(0);
    expect(clampPct(NaN, 100)).toBe(0);
  });

  it('formats the ring CSS variable', () => {
    expect(ringVar(72.4)).toBe('--p: 72');
    expect(ringVar(140)).toBe('--p: 100');
    expect(ringVar(NaN)).toBe('--p: 0');
  });
});

describe('nutrition macroViews', () => {
  const bars = [
    {
      key: 'proteinG',
      label: 'Protéines',
      pct: 51,
      over: false,
      detail: '87 / 171 g',
      consumed: 87,
    },
    { key: 'carbsG', label: 'Glucides', pct: 1, over: false, detail: '2 / 282 g', consumed: 2 },
    { key: 'fatG', label: 'Lipides', pct: 0, over: false, detail: '0 / 78 g', consumed: 0 },
  ] as const;

  it('keeps a width in % readable by style.width and a distinct colour per macro', () => {
    const v = macroViews(bars);
    expect(v.map((m) => m.key)).toEqual(['proteinG', 'carbsG', 'fatG']);
    expect(v[0]!.barStyle).toMatch(/^width: 51%;/);
    // Minimum visible dès la première bouchée
    expect(v[1]!.barStyle).toMatch(/^width: 2%;/);
    expect(v[2]!.barStyle).toMatch(/^width: 0%;/);
    expect(v[0]!.dotStyle).toContain(MACRO_COLORS.proteinG.from);
    const colours = new Set(Object.values(MACRO_COLORS).map((c) => c.from));
    expect(colours.size).toBe(3);
  });
});
