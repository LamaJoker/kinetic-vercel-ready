/**
 * Globaux de plateforme autorisés dans le core (QA-12).
 *
 * Le core compile SANS la lib DOM (packages/core/tsconfig.json : `lib: ["ES2022"]`) :
 * `window`, `document`, `localStorage`, `indexedDB`… n'y existent pas, et tout usage
 * d'une API navigateur échoue au typecheck. Seules les fonctions ci-dessous, présentes
 * à l'identique dans les navigateurs, Node ≥ 16 et Deno, sont déclarées.
 */
declare function btoa(data: string): string;
declare function atob(data: string): string;
