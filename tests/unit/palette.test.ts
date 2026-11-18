import { describe, it, expect, vi } from 'vitest';

vi.mock('alpinejs', () => ({ default: { store: () => undefined } }));
vi.mock('../../apps/web/src/lib/barcode-camera', () => ({
  cameraScanSupported: () => false,
  scanBarcodeWithCamera: vi.fn(),
}));
import {
  ACCENT_HEX,
  MACRO_COLORS,
  PAGE_BG_DARK,
  PAGE_BG_LIGHT,
  ROLE_COLORS,
  cssVar,
  pageBackground,
} from '../../apps/web/src/lib/palette.js';
import { buildMacroBars } from '../../apps/web/src/stores/nutrition.js';
import { macroViews } from '../../apps/web/src/pages/nutrition.page.js';

describe('palette « Nuit profonde & corail »', () => {
  it('référence les variables CSS, avec ou sans opacité', () => {
    expect(cssVar('--k-info')).toBe('rgb(var(--k-info))');
    expect(cssVar('--k-info', 0.5)).toBe('rgb(var(--k-info) / 0.5)');
  });

  it('trois couleurs de macros distinctes, sans hexadécimal codé en dur', () => {
    const froms = Object.values(MACRO_COLORS).map((c) => c.from);
    expect(new Set(froms).size).toBe(3);
    for (const c of Object.values(MACRO_COLORS)) {
      expect(c.from).toMatch(/^rgb\(var\(--k-macro-[pcf]\)\)$/);
      expect(c.to).toMatch(/^rgb\(var\(--k-macro-[pcf]-2\)\)$/);
      expect(c.glow).toMatch(/\/ 0\.5\)$/);
    }
  });

  it('le store et la page Nutrition partagent les mêmes couleurs', () => {
    const bars = buildMacroBars(
      { proteinG: 10, carbsG: 10, fatG: 10 },
      { proteinG: 100, carbsG: 100, fatG: 100 },
    );
    const views = macroViews(bars);
    bars.forEach((b, i) => {
      expect(b.style.backgroundColor).toBe(MACRO_COLORS[b.key].from);
      expect(views[i]!.dotStyle).toContain(MACRO_COLORS[b.key].from);
      expect(views[i]!.barStyle).toContain(MACRO_COLORS[b.key].glow);
    });
  });

  it('fond de barre d’état : bleu nuit en sombre, lavande en clair', () => {
    expect(pageBackground('dark')).toBe(PAGE_BG_DARK);
    expect(pageBackground('light')).toBe(PAGE_BG_LIGHT);
    expect(PAGE_BG_DARK).toBe('#0B0E1A');
    expect(ACCENT_HEX).toBe('#FF7A66');
  });

  it('rôles sémantiques branchés sur les variables', () => {
    expect(ROLE_COLORS.success).toBe('rgb(var(--k-success))');
    expect(ROLE_COLORS.warning).toBe('rgb(var(--k-warning))');
    expect(ROLE_COLORS.accent).toBe('rgb(var(--kinetic-neon))');
  });
});
