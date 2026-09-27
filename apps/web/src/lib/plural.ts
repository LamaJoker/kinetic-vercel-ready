/**
 * Accord en nombre : « 1 séance », « 3 séances », « 0 séance ».
 * Remplace les « séance(s) » qui trahissent un gabarit.
 * En français, 0 et 1 sont au singulier.
 */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  const count = Number.isFinite(n) ? n : 0;
  return `${count} ${Math.abs(count) >= 2 ? many : one}`;
}

/** Variante sans le nombre : pratique quand le chiffre est affiché ailleurs. */
export function pluralWord(n: number, one: string, many: string = `${one}s`): string {
  return Math.abs(Number.isFinite(n) ? n : 0) >= 2 ? many : one;
}
