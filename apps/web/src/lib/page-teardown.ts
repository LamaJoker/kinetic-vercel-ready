import type { Alpine } from 'alpinejs';

/**
 * Détruit les composants Alpine de la page quittée, UNE seule fois (QA-10).
 *
 * `Alpine.destroyTree` (API publique) exécute les nettoyages de chaque élément, dont le
 * `destroy()` des composants `x-data`, puis les oublie : quand l'observateur de
 * mutations d'Alpine voit ensuite les nœuds retirés (`host.innerHTML = …`) et rappelle
 * `destroyTree`, il n'y a plus rien à exécuter. L'ancien appel manuel de `destroy()`
 * (via le champ interne `_x_dataStack`) s'ajoutait à celui d'Alpine : deux exécutions.
 *
 * À appeler APRÈS la copie figée de la page (geste « retour ») : le nettoyage d'Alpine
 * retire du DOM les éléments rendus par `x-if` / `x-for`.
 */
export function destroyPageComponents(
  host: HTMLElement,
  alpine: Pick<Alpine, 'destroyTree'>,
): void {
  try {
    alpine.destroyTree(host);
  } catch (err) {
    console.warn('[router] component destroy failed:', err);
  }
}
