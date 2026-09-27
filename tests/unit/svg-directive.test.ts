import { describe, it, expect, vi } from 'vitest';
import { sanitizeSvg, registerSvgDirective } from '../../apps/web/src/lib/svg-directive.js';

describe('sanitizeSvg', () => {
  it('laisse passer un SVG simple', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect x="1" y="1" width="2" height="2"/></svg>';
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it('refuse ce qui n est pas un SVG', () => {
    expect(sanitizeSvg('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeSvg(42)).toBe('');
  });

  it('retire scripts, gestionnaires et liens javascript:', () => {
    const out = sanitizeSvg(
      '<svg><script>alert(1)</script><rect onclick="alert(1)" /><a href="javascript:alert(1)"><text>x</text></a><foreignObject><div></div></foreignObject></svg>',
    );
    expect(out).not.toMatch(/script|onclick|javascript:|foreignObject/i);
    expect(out).toContain('<rect');
  });
});

describe('directive x-svg', () => {
  it('injecte la valeur évaluée dans l élément', () => {
    let registered: ((el: Element, b: { expression: string }, u: never) => void) | null = null;
    registerSvgDirective({
      directive: (_name, cb) => {
        registered = cb as never;
      },
    });
    const el = { innerHTML: '' } as unknown as Element;
    const effect = vi.fn((fn: () => void) => fn());
    const evaluateLater = () => (cb: (v: unknown) => void) => cb('<svg><circle r="1"/></svg>');
    registered!(el, { expression: 'chartSvg()' }, { effect, evaluateLater } as never);
    expect(el.innerHTML).toBe('<svg><circle r="1"/></svg>');
  });
});
