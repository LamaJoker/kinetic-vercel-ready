/**
 * Finitions : garde-fous CSS.
 *  - Mode clair : chaque thème d'accent a un accent GRAPHIQUE vif (--kinetic-neon)
 *    et un accent TEXTE (--kinetic-neon-ink) lisible (WCAG AA ≥ 4,5:1) ; le texte
 *    sombre posé sur l'accent graphique reste lisible.
 *  - Contrôle segmenté unique : plus de pastilles k-chip dans les pages, et la
 *    pastille glissante de .k-seg couvre 2 à 6 segments.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '../../apps/web/src');
const styles = readFileSync(resolve(WEB, 'styles.css'), 'utf8');
const finitions = readFileSync(resolve(WEB, 'styles/finitions.css'), 'utf8');

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
function parseRgb(value: string): Rgb {
  const parts = value.trim().split(/\s+/).map(Number);
  expect(parts).toHaveLength(3);
  return parts as Rgb;
}
/** Valeur d'une variable « R G B » dans le premier bloc dont le sélecteur matche. */
function varIn(selector: RegExp, name: string): Rgb {
  const block = new RegExp(`${selector.source}[^{]*\\{([^}]*)\\}`).exec(styles);
  expect(block, `bloc ${selector}`).not.toBeNull();
  const decl = new RegExp(`${name}:\\s*([0-9 ]+);`).exec(block![1]!);
  expect(decl, `${name} dans ${selector}`).not.toBeNull();
  return parseRgb(decl![1]!);
}

const darkThemes = [...styles.matchAll(/\[data-theme='([a-z]+)'\]\s*\{/g)].map((m) => m[1]!);

describe('mode clair : accent texte vs accent graphique', () => {
  const PAGE: Rgb = [242, 242, 247]; // --ink clair
  const CARD: Rgb = [255, 255, 255]; // --surface clair
  const ON_ACCENT: Rgb = [10, 10, 12]; // texte posé sur l'accent

  it('lists every unlockable theme', () => {
    expect(darkThemes).toEqual(
      expect.arrayContaining(['electrique', 'cyber', 'violet', 'phoenix', 'fantome']),
    );
  });

  it.each(['electrique', 'cyber', 'violet', 'phoenix', 'fantome'])(
    'theme %s: readable text accent, vivid graphic accent',
    (theme) => {
      const sel = new RegExp(`\\[data-mode='light'\\]\\[data-theme='${theme}'\\]`);
      const ink = varIn(sel, '--kinetic-neon-ink');
      const gfx = varIn(sel, '--kinetic-neon');
      expect(contrast(ink, PAGE)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ink, CARD)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(ON_ACCENT, gfx)).toBeGreaterThanOrEqual(4.5);
      // L'accent graphique est plus clair (plus vif) que l'accent texte
      expect(luminance(gfx)).toBeGreaterThan(luminance(ink));
    },
  );

  it('the default theme (no data-theme) uses the same light values as electrique', () => {
    expect(styles).toMatch(
      /\[data-mode='light'\]:not\(\[data-theme\]\),\s*\[data-mode='light'\]\[data-theme='electrique'\]/,
    );
  });

  it('text accent follows --kinetic-neon-ink, rings and charts follow --kinetic-neon', () => {
    expect(finitions).toMatch(
      /\[data-mode='light'\] \.text-kinetic-neon \{\s*color: rgb\(var\(--kinetic-neon-ink\)\);/,
    );
    expect(finitions).toMatch(/\[data-mode='light'\] \.text-kinetic-neon > \.k-ring,/);
    expect(finitions).toMatch(
      /:root:not\(\[data-mode='light'\]\) \{\s*--kinetic-neon-ink: var\(--kinetic-neon\);/,
    );
  });
});

describe('contrôle segmenté unique (.k-seg)', () => {
  const pages = readdirSync(resolve(WEB, 'pages')).filter((f) => f.endsWith('.html'));

  it('no page uses the legacy k-chip filter pills any more', () => {
    for (const page of pages) {
      const html = readFileSync(resolve(WEB, 'pages', page), 'utf8');
      expect(html, page).not.toMatch(/class="[^"]*\bk-chip\b/);
    }
  });

  it('every static k-seg has between 2 and 6 segments', () => {
    for (const page of pages) {
      const html = readFileSync(resolve(WEB, 'pages', page), 'utf8');
      const groups = html.split(/class="k-seg[ "]/).slice(1);
      for (const group of groups) {
        // Fin du groupe : premier </div> (les segments sont des <button> à plat)
        const body = group.slice(0, group.indexOf('</div>'));
        if (body.includes('x-for')) continue; // segments générés : nombre vérifié à l'écran
        const count = (body.match(/class="k-seg-item/g) ?? []).length;
        expect(count, page).toBeGreaterThanOrEqual(2);
        expect(count, page).toBeLessThanOrEqual(6);
      }
    }
  });

  it('the sliding accent pill knows 2 to 6 segments and every active position', () => {
    for (let n = 2; n <= 6; n++) {
      expect(finitions).toContain(`.k-seg:has(> button:nth-of-type(${n}):last-of-type)`);
      expect(finitions).toContain(`--k-seg-n: ${n};`);
      expect(finitions).toContain(`--k-seg-i: ${n - 1};`);
    }
  });

  it('turns motion off under prefers-reduced-motion', () => {
    const rm = finitions.slice(finitions.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toMatch(/\.k-seg::before,\s*\.k-seg > \.k-seg-item \{\s*transition: none;/);
  });
});
