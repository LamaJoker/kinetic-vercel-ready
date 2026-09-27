/**
 * Directive Alpine `x-svg` — insère un SVG généré par l'application.
 *
 * Pourquoi : le build CSP d'Alpine (@alpinejs/csp) INTERDIT `x-html`
 * (« Using the x-html directive is prohibited in the CSP build »). Toutes les
 * courbes (poids, mensurations, force, e1RM) et la barre chargée restaient donc
 * vides en production. `x-svg` n'accepte qu'une chaîne commençant par `<svg`,
 * nettoyée de tout script, gestionnaire d'événement et lien `javascript:`.
 */

/** Nettoyage défensif (les SVG viennent de nos propres fonctions de rendu). */
export function sanitizeSvg(markup: unknown): string {
  if (typeof markup !== 'string') return '';
  const trimmed = markup.trim();
  if (!/^<svg[\s>]/i.test(trimmed)) return '';
  return trimmed
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(foreignObject|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
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

export function registerSvgDirective(Alpine: AlpineLike): void {
  Alpine.directive('svg', (el, { expression }, { effect, evaluateLater }) => {
    const read = evaluateLater(expression);
    effect(() => {
      read((value) => {
        el.innerHTML = sanitizeSvg(value);
      });
    });
  });
}
