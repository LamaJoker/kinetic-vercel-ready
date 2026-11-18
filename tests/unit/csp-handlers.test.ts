/**
 * Build CSP d'Alpine : une directive ne contient qu'UNE expression. Un gestionnaire
 * « a = 1; b = 2 » est rejeté (« CSP Parser Error ») et le bouton ne fait rien.
 * Garde-fou : aucune directive Alpine à plusieurs instructions dans les pages.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '../../apps/web');

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = resolve(dir, d.name);
    if (d.isDirectory()) return htmlFiles(p);
    return d.name.endsWith('.html') ? [p] : [];
  });
}

/** Directive Alpine (@…, x-on:…, x-init, x-effect) dont la valeur contient « ; » suivi d'autre chose. */
const MULTI = /\s(?:@[\w.:-]+|x-on:[\w.:-]+|x-init|x-effect)="[^"]*;\s*[^"\s][^"]*"/g;

describe('directives Alpine compatibles CSP', () => {
  it('aucune directive à plusieurs instructions', () => {
    const files = [resolve(WEB, 'index.html'), ...htmlFiles(resolve(WEB, 'src'))];
    const offenders = files.flatMap((f) =>
      (readFileSync(f, 'utf8').match(MULTI) ?? []).map((m) => `${f}: ${m.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
