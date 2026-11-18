import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXERCISE_ILLUSTRATIONS,
  clearIllustrationCache,
  exerciseIllustrations,
  hasIllustration,
  illustrationName,
  illustrationUrl,
  loadIllustration,
} from '../../apps/web/src/lib/exercise-illustrations';
import {
  rebuildSafeSvg,
  type SourceNode,
  type TargetDocument,
} from '../../apps/web/src/lib/svg-directive';

const ROOT = resolve(__dirname, '../..');
const DIR = resolve(ROOT, 'apps/web/public/exercises');
const catalog = JSON.parse(
  readFileSync(resolve(ROOT, 'apps/web/public/exercises.v1.json'), 'utf8'),
) as Array<{ id: string }>;
const files = readdirSync(DIR).filter((f) => f.endsWith('.svg'));

beforeEach(() => clearIllustrationCache());

/** Analyse XML minimale (éléments + attributs) pour rebuildSafeSvg sous Node. */
function parse(xml: string): SourceNode {
  const root: SourceNode & { childNodes: SourceNode[] } = {
    nodeType: 9,
    textContent: '',
    childNodes: [],
  };
  const stack: Array<SourceNode & { childNodes: SourceNode[] }> = [root];
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const parent = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (m[5].trim()) parent.childNodes.push({ nodeType: 3, textContent: m[5], childNodes: [] });
      continue;
    }
    if (m[1]) {
      stack.pop();
      continue;
    }
    const attributes = [...m[3]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => ({
      name: a[1]!,
      value: a[2]!,
    }));
    const el = {
      nodeType: 1,
      localName: m[2]!,
      textContent: '',
      attributes,
      childNodes: [] as SourceNode[],
    };
    parent.childNodes.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.childNodes[0]!;
}

/** Document cible qui compte ce qui est recréé. */
function countingDoc() {
  const made = { elements: 0, attributes: 0 };
  const doc: TargetDocument = {
    createElementNS: () => {
      made.elements++;
      return { setAttribute: () => void made.attributes++, appendChild: () => undefined };
    },
    createTextNode: () => ({}),
  };
  return { doc, made };
}

describe('schémas d’exercices : fichiers', () => {
  it('au moins 30 exercices courants ont un schéma', () => {
    expect(Object.keys(EXERCISE_ILLUSTRATIONS).length).toBeGreaterThanOrEqual(30);
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it('chaque identifiant existe dans le catalogue', () => {
    const ids = new Set(catalog.map((e) => e.id));
    const unknown = Object.keys(EXERCISE_ILLUSTRATIONS).filter((id) => !ids.has(id));
    expect(unknown).toEqual([]);
  });

  it('chaque schéma référencé existe, et chaque fichier sert', () => {
    const used = new Set(Object.values(EXERCISE_ILLUSTRATIONS));
    for (const name of used) expect(files).toContain(`${name}.svg`);
    for (const f of files) expect(used.has(f.replace(/\.svg$/, ''))).toBe(true);
  });

  it.each(files)('%s : SVG sûr, titré, au style commun, recréé en entier par x-svg', (f) => {
    const text = readFileSync(resolve(DIR, f), 'utf8');
    expect(text).toMatch(/^<svg [^>]*viewBox="0 0 160 160"/);
    expect(text).toMatch(/<title>[^<]+<\/title>/);
    expect(text).toContain('class="m"'); // muscle principal en accent
    expect(text).not.toMatch(/<script|<style|href=|on\w+=|<foreignObject/i);
    expect(text.length).toBeLessThan(4000);

    const tree = parse(text);
    const { doc, made } = countingDoc();
    expect(rebuildSafeSvg(tree, doc)).not.toBeNull();
    const elements = (text.match(/<[a-zA-Z]+/g) ?? []).length;
    expect(made.elements).toBe(elements); // aucun élément écarté par la liste fermée
  });
});

describe('schémas d’exercices : chargement', () => {
  const svg = '<svg viewBox="0 0 160 160"></svg>';
  const ok = (body: string, type = 'image/svg+xml') =>
    Promise.resolve({ ok: true, headers: { get: () => type }, text: () => Promise.resolve(body) });

  it('identifiants sans schéma : rien', () => {
    expect(illustrationName('bike')).toBeNull();
    expect(illustrationName(undefined)).toBeNull();
    expect(illustrationName('toString')).toBeNull();
    expect(hasIllustration('sq')).toBe(true);
    expect(illustrationUrl('squat')).toBe('/exercises/squat.svg');
  });

  it('télécharge une seule fois', async () => {
    const fetcher = vi.fn(() => ok(svg));
    await expect(loadIllustration('squat', fetcher)).resolves.toBe(svg);
    await expect(loadIllustration('squat', fetcher)).resolves.toBe(svg);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/exercises/squat.svg');
  });

  it('refuse la page HTML de repli, puis réessaie', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => ok('<!doctype html>', 'text/html'))
      .mockImplementationOnce(() => ok(svg));
    await expect(loadIllustration('curl', fetcher)).rejects.toThrow(/indisponible/);
    await expect(loadIllustration('curl', fetcher)).resolves.toBe(svg);
  });

  it('refuse un contenu qui n’est pas un SVG', async () => {
    await expect(loadIllustration('dips', () => ok('bonjour', 'text/plain'))).rejects.toThrow(
      /invalide/,
    );
  });

  it('composant : vide puis SVG à l’arrivée, guide si consignes ou schéma', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => ok(svg)),
    );
    const host = {
      ...exerciseIllustrations(),
      cues: (id: string) => (id === 'bike' ? { execution: [] } : null),
    };
    expect(host.illustrationSvg('sq')).toBe('');
    await new Promise((r) => setTimeout(r, 0));
    expect(host.illustrations).toEqual({ squat: svg });
    expect(host.illustrationSvg('box_sq')).toBe(svg); // même schéma
    expect(host.illustrationSvg('bike')).toBe('');
    expect(host.hasGuide('bike')).toBe(true);
    expect(host.hasGuide('plank')).toBe(true);
    expect(host.hasGuide('tire_flip')).toBe(false);
    vi.unstubAllGlobals();
  });
});
