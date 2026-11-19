/**
 * Directives Alpine des gestes de saisie et des courbes, au code chargé à la demande.
 *
 * Alpine doit connaître une directive AVANT de rencontrer l'attribut ; leur code
 * (gestes, calque de courbe) ne sert pourtant que sur quelques pages. Ici, seul
 * un petit stub est enregistré au démarrage : au premier élément rencontré, il
 * importe le module (chunk à part, mis en cache) puis branche l'élément.
 *
 *   x-scrub="chartScrub()"       courbe à parcourir du doigt (lib/chart-scrub.ts)
 *   x-swipe:right="…" / :left    ligne à glisser (lib/swipe-row.ts)
 *   x-hold="bumpWeight(1)"       appui maintenu = répétition (lib/hold-repeat.ts)
 */

type Cleanup = () => void;

interface DirectiveUtils {
  evaluateLater: (expr: string) => (cb?: (value: unknown) => void) => void;
  cleanup: (fn: Cleanup) => void;
}

interface AlpineLike {
  directive(
    name: string,
    cb: (
      el: Element,
      binding: { expression: string; value: string },
      utils: DirectiveUtils,
    ) => void,
  ): void;
}

/** Branche `bind` sur l'élément une fois `load` résolu (sauf s'il a disparu entre-temps). */
function lazily<M>(
  load: () => Promise<M>,
  cleanup: (fn: Cleanup) => void,
  bind: (m: M) => Cleanup,
): void {
  let dispose: Cleanup | null = null;
  let gone = false;
  cleanup(() => {
    gone = true;
    dispose?.();
  });
  load()
    .then((m) => {
      if (!gone) dispose = bind(m);
    })
    .catch(() => undefined); // hors-ligne sans cache : la page reste utilisable sans le geste
}

export function registerLazyDirectives(Alpine: AlpineLike): void {
  Alpine.directive('scrub', (el, { expression }, { evaluateLater, cleanup }) => {
    const evaluate = evaluateLater(expression);
    const read = (): never => {
      let out: unknown = null;
      evaluate((v) => {
        out = v;
      });
      return out as never;
    };
    lazily(
      () => import('./chart-scrub'),
      cleanup,
      (m) => m.bindChartScrub(el as HTMLElement, read),
    );
  });

  Alpine.directive('swipe', (el, { expression, value }, { evaluateLater, cleanup }) => {
    if (value !== 'left' && value !== 'right') return;
    const run = evaluateLater(expression);
    lazily(
      () => import('./swipe-row'),
      cleanup,
      (m) =>
        // Attend la fin d'une action asynchrone (store) avant de remettre la ligne.
        m.bindSwipe(el as HTMLElement, value, () => new Promise<unknown>((done) => run(done))),
    );
  });

  Alpine.directive('hold', (el, { expression }, { evaluateLater, cleanup }) => {
    const run = evaluateLater(expression);
    lazily(
      () => import('./hold-repeat'),
      cleanup,
      (m) => m.bindHoldRepeat(el as HTMLElement, () => run()),
    );
  });
}
