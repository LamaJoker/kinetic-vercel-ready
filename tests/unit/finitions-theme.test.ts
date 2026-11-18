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
const tailwind = readFileSync(resolve(WEB, '../tailwind.config.js'), 'utf8');

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
  const PAGE: Rgb = [244, 243, 250]; // --ink clair (lavande)
  const CARD: Rgb = [255, 255, 255]; // --surface clair
  const ON_ACCENT: Rgb = [26, 13, 18]; // --k-on-accent : texte posé sur l'accent

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
    // Texte : textColor de tailwind.config.js (variante -ink de chaque accent)
    expect(tailwind).toContain(
      "textColor: {\n        'kinetic-neon': 'rgb(var(--kinetic-neon-ink) / <alpha-value>)',",
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

describe('palette « Nuit profonde & corail » : contrastes texte (WCAG AA)', () => {
  const DARK = { ink: [11, 14, 26], surface: [21, 26, 44], elevated: [32, 38, 59] } as const;
  const LIGHT = {
    ink: [244, 243, 250],
    surface: [255, 255, 255],
    elevated: [237, 236, 245],
  } as const;
  const darkRoot = /:root (?=\{\n {2}--ink: 11 14 26;)/;
  const lightRoot = /\[data-mode='light'\] (?=\{\n {2}--ink: 244 243 250;)/;

  it('surfaces bleu nuit et accent corail par défaut', () => {
    expect(varIn(darkRoot, '--ink')).toEqual([11, 14, 26]);
    expect(varIn(darkRoot, '--surface')).toEqual([21, 26, 44]);
    expect(varIn(/:root,\s*\[data-theme='electrique'\]/, '--kinetic-neon')).toEqual([
      255, 122, 102,
    ]);
  });

  it.each(['--k-success-ink', '--k-info-ink', '--k-warning-ink', '--k-danger-ink', '--tx2-rgb'])(
    'sombre : %s ≥ 4,5:1 sur ink, surface et elevated',
    (name) => {
      const c = varIn(darkRoot, name);
      for (const bg of Object.values(DARK))
        expect(contrast(c, [...bg])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(['--k-success-ink', '--k-info-ink', '--k-warning-ink', '--k-danger-ink', '--tx2-rgb'])(
    'clair : %s ≥ 4,5:1 sur ink, surface et elevated',
    (name) => {
      const c = varIn(lightRoot, name);
      for (const bg of Object.values(LIGHT))
        expect(contrast(c, [...bg])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('le texte sombre --k-on-accent se lit sur le corail (≥ 4,5:1)', () => {
    const onAccent = varIn(darkRoot, '--k-on-accent');
    expect(contrast(onAccent, [255, 122, 102])).toBeGreaterThanOrEqual(4.5);
  });

  it('les couleurs Tailwind kinetic-* lisent les variables de la palette', () => {
    expect(tailwind).toContain("'kinetic-teal': 'rgb(var(--k-success) / <alpha-value>)'");
    expect(tailwind).toContain("'kinetic-purple': 'rgb(var(--k-info) / <alpha-value>)'");
    expect(tailwind).toContain("'kinetic-gold': 'rgb(var(--k-warning) / <alpha-value>)'");
    expect(tailwind).toContain("'kinetic-coral': 'rgb(var(--k-danger) / <alpha-value>)'");
  });
});
