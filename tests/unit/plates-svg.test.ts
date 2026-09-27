import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { plates, renderBarbellSvg, plateGeometry } from '../../apps/web/src/pages/plates.page.js';

describe('barre chargée (SVG)', () => {
  it('dessine chaque disque des deux côtés', () => {
    const page = plates();
    page.targetKg = 140;
    page.barKg = 20;
    const svg = page.barbellSvg;
    // 60 kg par côté = 25 + 25 + 10 → 3 disques × 2 côtés + 4 rect de barre
    expect((svg.match(/<rect /g) ?? []).length).toBe(4 + 3 * 2);
    expect(svg).toContain('#dc2626'); // rouge 25 kg
    expect(svg).toContain('aria-label="Barre de 20 kg');
    if (process.env['WRITE_SVG']) writeFileSync('/tmp/barbell.svg', svg);
  });

  it('les disques de 10 à 25 kg ont le même diamètre', () => {
    expect(plateGeometry(25).height).toBe(plateGeometry(10).height);
    expect(plateGeometry(5).height).toBeLessThan(plateGeometry(10).height);
  });

  it('reste dans le cadre avec beaucoup de disques', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      key: String(i),
      width: 15,
      height: 116,
      color: '#dc2626',
      text: '#fff',
      label: '25',
    }));
    const xs = [...renderBarbellSvg(many, 20).matchAll(/<rect x="([\d.-]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(360);
  });
});
