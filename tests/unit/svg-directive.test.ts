import { describe, it, expect, vi } from 'vitest';
import {
  rebuildSafeSvg,
  registerSvgDirective,
  type SourceNode,
  type TargetDocument,
} from '../../apps/web/src/lib/svg-directive.js';

// ── Mini DOM de test ─────────────────────────────────────────────────────────
function el(
  localName: string,
  attrs: Record<string, string> = {},
  children: SourceNode[] = [],
): SourceNode {
  return {
    nodeType: 1,
    localName,
    textContent: null,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    childNodes: children,
  };
}
const text = (t: string): SourceNode => ({ nodeType: 3, textContent: t, childNodes: [] });

interface Built {
  name: string;
  attrs: Record<string, string>;
  children: Array<Built | string>;
}
const doc: TargetDocument = {
  createElementNS: (_ns, name) => {
    const node: Built & {
      setAttribute: (n: string, v: string) => void;
      appendChild: (c: unknown) => unknown;
    } = {
      name,
      attrs: {},
      children: [],
      setAttribute(n, v) {
        this.attrs[n] = v;
      },
      appendChild(c) {
        this.children.push(c as Built | string);
        return c;
      },
    };
    return node;
  },
  createTextNode: (t) => t,
};

function serialize(node: Built | string): string {
  if (typeof node === 'string') return node;
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  return `<${node.name}${attrs}>${node.children.map(serialize).join('')}</${node.name}>`;
}

describe('rebuildSafeSvg', () => {
  it('recopie un graphique légitime', () => {
    const src = el('svg', { viewBox: '0 0 10 10', role: 'img', 'aria-label': 'Courbe' }, [
      el('path', { d: 'M0 0L10 10', stroke: '#0f0', 'stroke-width': '2' }),
      el('text', { x: '1', y: '9', 'font-size': '8' }, [text('80 kg')]),
      el('circle', { cx: '5', cy: '5', r: '1', filter: 'url(#glow)' }),
    ]);
    const out = serialize(rebuildSafeSvg(src, doc) as unknown as Built);
    expect(out).toContain('<path d="M0 0L10 10"');
    expect(out).toContain('80 kg');
    expect(out).toContain('filter="url(#glow)"');
  });

  it('ne recrée jamais scripts, foreignObject, gestionnaires ni liens', () => {
    const src = el('svg', { onload: 'alert(1)' }, [
      el('script', {}, [text('alert(1)')]),
      el('foreignObject', {}, [el('iframe', { src: 'https://evil' })]),
      el('a', { href: 'javascript:alert(1)' }, [el('rect', { width: '1' })]),
      el('rect', { onclick: 'alert(1)', style: 'x', width: '2', fill: 'url(https://evil/x)' }),
      el('image', { href: 'data:image/svg+xml,...' }),
    ]);
    const out = serialize(rebuildSafeSvg(src, doc) as unknown as Built);
    expect(out).toBe('<svg><rect width="2"></rect></svg>');
  });

  it('refuse une racine non autorisée', () => {
    expect(rebuildSafeSvg(el('script'), doc)).toBeNull();
    expect(rebuildSafeSvg(text('x'), doc)).toBeNull();
  });
});

describe('directive x-svg', () => {
  it('remplace le contenu par le SVG rendu (ou vide si rejeté)', () => {
    let registered: ((el: Element, b: { expression: string }, u: never) => void) | null = null;
    const rendered = { tag: 'svg' };
    registerSvgDirective({ directive: (_n, cb) => void (registered = cb as never) }, (v) =>
      v === 'ok' ? rendered : null,
    );
    const replaceChildren = vi.fn();
    const target = { replaceChildren } as unknown as Element;
    const effect = (fn: () => void) => fn();
    for (const value of ['ok', 'rejeté']) {
      registered!(target, { expression: 'chartSvg()' }, {
        effect,
        evaluateLater: () => (cb: (v: unknown) => void) => cb(value),
      } as never);
    }
    expect(replaceChildren).toHaveBeenNthCalledWith(1, rendered);
    expect(replaceChildren).toHaveBeenNthCalledWith(2);
  });
});
