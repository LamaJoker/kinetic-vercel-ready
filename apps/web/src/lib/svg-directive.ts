/**
 * Directive Alpine `x-svg` — affiche un SVG généré par l'application.
 *
 * Pourquoi : le build CSP d'Alpine (@alpinejs/csp) INTERDIT `x-html`
 * (« Using the x-html directive is prohibited in the CSP build »). Les courbes
 * (poids, mensurations, force, e1RM) et la barre chargée restaient vides.
 *
 * Sécurité : aucun filtrage par expressions régulières. La chaîne est analysée
 * comme XML (DOMParser, `image/svg+xml`), puis RECONSTRUITE nœud par nœud dans
 * le document courant à partir d'une liste fermée d'éléments et d'attributs.
 * Tout le reste (scripts, foreignObject, gestionnaires `on*`, liens `href`,
 * `style`, `url()` externes) n'est jamais recréé.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'filter',
  'feGaussianBlur',
  'feDropShadow',
  'feMerge',
  'feMergeNode',
  'feOffset',
  'feFlood',
  'feComposite',
]);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewBox',
  'width',
  'height',
  'preserveAspectRatio',
  'role',
  'aria-label',
  'aria-hidden',
  'id',
  'class',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'd',
  'points',
  'transform',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'clip-path',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'vector-effect',
  'filter',
  'font-size',
  'font-weight',
  'font-family',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'stdDeviation',
  'in',
  'in2',
  'result',
  'operator',
  'flood-color',
  'flood-opacity',
  'mode',
]);

/** Une valeur `url(...)` n'est acceptée que vers un identifiant interne : url(#id). */
function isSafeValue(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:')) return false;
  const urls = lower.match(/url\s*\(/g);
  if (!urls) return true;
  return /^url\(\s*#[a-z0-9_-]+\s*\)$/i.test(value.trim());
}

/** Sous-ensemble du DOM utilisé (permet de tester sans navigateur). */
export interface SourceNode {
  nodeType: number;
  localName?: string;
  textContent: string | null;
  attributes?: ArrayLike<{ name: string; value: string }>;
  childNodes: ArrayLike<SourceNode>;
}

export interface TargetDocument {
  createElementNS(ns: string, name: string): TargetElement;
  createTextNode(text: string): unknown;
}

export interface TargetElement {
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
}

/** Recrée une copie sûre de `source` ; `null` si l'élément n'est pas autorisé. */
export function rebuildSafeSvg(source: SourceNode, doc: TargetDocument): TargetElement | null {
  if (source.nodeType !== 1 || !source.localName || !ALLOWED_ELEMENTS.has(source.localName)) {
    return null;
  }
  const out = doc.createElementNS(SVG_NS, source.localName);
  const attrs = source.attributes ?? [];
  for (let i = 0; i < attrs.length; i++) {
    const { name, value } = attrs[i]!;
    if (ALLOWED_ATTRIBUTES.has(name) && isSafeValue(value)) out.setAttribute(name, value);
  }
  for (let i = 0; i < source.childNodes.length; i++) {
    const child = source.childNodes[i]!;
    if (child.nodeType === 3) {
      out.appendChild(doc.createTextNode(child.textContent ?? ''));
    } else {
      const safe = rebuildSafeSvg(child, doc);
      if (safe) out.appendChild(safe);
    }
  }
  return out;
}

/** Analyse une chaîne SVG et renvoie l'élément reconstruit (navigateur uniquement). */
export function renderSvgMarkup(markup: unknown): TargetElement | null {
  if (typeof markup !== 'string' || typeof DOMParser === 'undefined') return null;
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  return rebuildSafeSvg(root as unknown as SourceNode, document as unknown as TargetDocument);
}

interface AlpineLike {
  directive(
    name: string,
    cb: (
      el: Element,
      binding: { expression: string },
      utils: {
        effect: (fn: () => void) => void;
        evaluateLater: (expr: string) => (cb: (value: unknown) => void) => void;
      },
    ) => void,
  ): void;
}

export function registerSvgDirective(
  Alpine: AlpineLike,
  render: (markup: unknown) => unknown = renderSvgMarkup,
): void {
  Alpine.directive('svg', (el, { expression }, { effect, evaluateLater }) => {
    const read = evaluateLater(expression);
    effect(() => {
      read((value) => {
        const svg = render(value);
        el.replaceChildren(...(svg ? [svg as Node] : []));
      });
    });
  });
}
