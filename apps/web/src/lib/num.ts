/**
 * Helpers numériques exposés aux templates via la magie `$num`.
 *
 * Le build CSP d'Alpine refuse tout accès à un objet global (`Math`, `Date`…)
 * dans une expression, même obtenu via une magie : `$math.round(x)` échouait
 * avec « Accessing global variables is prohibited ». Ces fonctions sont nos
 * propres fonctions, donc autorisées.
 */
export const num = {
  round(n: number, digits = 0): number {
    const f = 10 ** digits;
    return Number.isFinite(n) ? Math.round(n * f) / f : 0;
  },
  min(...values: number[]): number {
    return Math.min(...values);
  },
  max(...values: number[]): number {
    return Math.max(...values);
  },
  abs(n: number): number {
    return Math.abs(n);
  },
  /** Pourcentage borné 0–100, arrondi. */
  pct(value: number, total: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  },
};
