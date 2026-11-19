/**
 * Chiffres qui défilent — directive Alpine `x-count`.
 *
 * Posée à côté d'un `x-text` (sans valeur : `<span x-text="…" x-count></span>`),
 * elle ne remplace PAS x-text : x-text écrit la valeur finale, la directive la
 * lit, puis réécrit le texte image par image de l'ancienne valeur (0 au premier
 * affichage) vers la nouvelle, en ~600 ms avec un ralenti doux.
 *
 * - Le format du texte est conservé tel quel : préfixe et suffixe (« ~ », « kg »,
 *   « / 2 000 »), virgule décimale, nombre de décimales, séparateur de milliers
 *   (espace fine, insécable ou ordinaire) et signe (« + », « − »).
 * - Premier affichage : l'animation part quand l'élément devient visible
 *   (IntersectionObserver) ; hors écran, rien ne bouge.
 * - Mouvement réduit (prefers-reduced-motion) : aucune animation, x-text seul.
 * - Texte sans nombre (« — ») : affiché tel quel ; le nombre suivant repart de 0.
 *
 * Chargé au démarrage (main.ts) : le tableau de bord, premier écran, l'utilise.
 */

export const COUNT_DURATION_MS = 600;

/** Nombre trouvé dans un texte, avec de quoi le réécrire au même format. */
export interface CountFormat {
  prefix: string;
  suffix: string;
  value: number;
  decimals: number;
  /** Séparateur décimal du texte d'origine (« , » par défaut, en français). */
  decimalSep: string;
  /** Séparateur de milliers vu dans le texte (null : pas de groupement). */
  groupSep: string | null;
  /** Signe explicite : '+', '-' ou '−' (U+2212), sinon ''. */
  sign: string;
}

// Signe facultatif, partie entière (groupée par 3 avec espace ordinaire,
// insécable U+00A0 ou fine insécable U+202F), décimales facultatives.
const NUMBER_RE = /([+\-\u2212]?)(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:([.,])(\d+))?/;

/** Lit le premier nombre d'un texte ; null s'il n'y en a pas. */
export function parseCountText(text: string): CountFormat | null {
  const m = NUMBER_RE.exec(text);
  if (!m) return null;
  const [all, sign = '', intPart = '', decSep, decPart] = m;
  const group = /[ \u00a0\u202f]/.exec(intPart)?.[0] ?? null;
  const digits = intPart.replace(/[ \u00a0\u202f]/g, '');
  const abs = Number(digits + (decPart ? '.' + decPart : ''));
  if (!Number.isFinite(abs)) return null;
  const negative = sign === '-' || sign === '\u2212';
  return {
    prefix: text.slice(0, m.index),
    suffix: text.slice(m.index + all.length),
    value: negative ? -abs : abs,
    decimals: decPart ? decPart.length : 0,
    decimalSep: decSep ?? ',',
    groupSep: group,
    sign,
  };
}

/** Écrit `value` au format de `fmt` (mêmes décimales, séparateurs, préfixe, suffixe). */
export function formatLike(value: number, fmt: CountFormat): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(fmt.decimals);
  const [int = '0', dec] = fixed.split('.');
  const grouped = fmt.groupSep ? int.replace(/\B(?=(\d{3})+(?!\d))/g, fmt.groupSep) : int;
  let sign = '';
  if (negative && Number(fixed) !== 0) sign = fmt.sign === '-' ? '-' : '\u2212';
  else if (fmt.sign === '+') sign = '+';
  return fmt.prefix + sign + grouped + (dec ? fmt.decimalSep + dec : '') + fmt.suffix;
}

/** Ralenti doux (ease-out cubique) : vite au départ, se pose en douceur. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** Texte à afficher à l'instant `t` (0 → 1) d'une animation de `from` vers `to`. */
export function countFrame(from: number, to: CountFormat, t: number): string {
  return formatLike(from + (to.value - from) * easeOutCubic(t), to);
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Branche l'animation sur un élément dont le texte est écrit par x-text.
 * Retourne la fonction de nettoyage.
 */
export function bindCountUp(el: HTMLElement): () => void {
  if (typeof MutationObserver === 'undefined' || reducedMotion()) return () => undefined;

  let shown: number | null = null; // valeur affichée (en cours d'animation ou finale)
  let pendingText: string | null = null; // texte final en attente de visibilité
  let raf = 0;
  let visible = typeof IntersectionObserver === 'undefined';

  let mo: MutationObserver | null = null;
  // Nos propres écritures ne doivent pas être prises pour une nouvelle valeur :
  // leurs mutations sont retirées de la file aussitôt. (Comparer au dernier
  // texte écrit ne suffit pas : x-text peut écrire ce même texte, ex. la vraie
  // valeur 0 alors que l'élément caché affiche son point de départ « 0 ».)
  const write = (text: string): void => {
    mo?.takeRecords();
    el.textContent = text;
    mo?.takeRecords();
  };

  const animate = (finalText: string): void => {
    cancelAnimationFrame(raf);
    const target = parseCountText(finalText);
    if (!target) {
      shown = null;
      if (el.textContent !== finalText) write(finalText);
      return;
    }
    const from = shown ?? 0;
    if (from === target.value) {
      shown = target.value;
      if (el.textContent !== finalText) write(finalText);
      return;
    }
    const start = performance.now();
    write(countFrame(from, target, 0));
    const step = (now: number): void => {
      const t = (now - start) / COUNT_DURATION_MS;
      if (t >= 1) {
        write(finalText);
        shown = target.value;
        return;
      }
      const v = from + (target.value - from) * easeOutCubic(t);
      shown = v;
      write(formatLike(v, target));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const onChange = (): void => {
    const text = el.textContent ?? '';
    if (visible) {
      animate(text);
      return;
    }
    // Pas encore à l'écran : on retient la valeur et on affiche son point de départ
    // (pas d'éclair de la valeur finale avant l'animation).
    pendingText = text;
    const target = parseCountText(text);
    if (target) write(countFrame(0, target, 0));
  };

  mo = new MutationObserver(onChange);
  mo.observe(el, { childList: true, characterData: true, subtree: true });

  let io: IntersectionObserver | null = null;
  if (!visible) {
    io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      visible = true;
      io?.disconnect();
      io = null;
      const text = pendingText;
      pendingText = null;
      if (text !== null) animate(text);
    });
    io.observe(el);
  }
  // Texte déjà posé par x-text avant la directive : traité comme une valeur.
  if (el.textContent) onChange();

  return () => {
    cancelAnimationFrame(raf);
    mo.disconnect();
    io?.disconnect();
  };
}

interface AlpineDirectiveHost {
  directive(
    name: string,
    cb: (el: Element, binding: unknown, utils: { cleanup: (fn: () => void) => void }) => void,
  ): void;
}

/** Enregistre `x-count` (main.ts, avant Alpine.start). */
export function registerCountDirective(Alpine: AlpineDirectiveHost): void {
  Alpine.directive('count', (el, _binding, { cleanup }) => {
    cleanup(bindCountUp(el as HTMLElement));
  });
}
