/**
 * Mémo des calculs dérivés d'une page (statistiques, records…), HORS état réactif.
 *
 * Alpine réévalue chaque liaison du gabarit séparément : un getter qui parcourt tout
 * l'historique est recalculé autant de fois qu'il est lu (8 à 12 fois par écran pour
 * le bilan hebdo de Progression, 2 fois par série affichée pour les records de
 * Séances). Ici, chaque valeur est calculée UNE fois pour un jeu de dépendances
 * donné, puis relue tant qu'elles n'ont pas changé.
 *
 * Les dépendances sont comparées par identité (`===`) : on y met les tableaux BRUTS
 * (`Alpine.raw(this.sessions)`), remplacés par un nouveau tableau à chaque
 * modification (chargement, enregistrement, suppression, modification d'une séance
 * passée). Le cache n'est donc jamais périmé tant qu'aucun code ne modifie ces
 * tableaux sur place — règle déjà suivie par les pages (affectation d'un nouveau
 * tableau, nécessaire aussi pour qu'Alpine voie le changement).
 *
 * Le cache vit dans la fermeture du composant, pas dans ses données : Alpine ne le
 * rend pas réactif (aucun proxy sur des milliers de séries) et ne le suit pas.
 */
export interface DerivedCache {
  /**
   * Valeur `name` pour ces dépendances : `compute()` n'est appelé que si elles ont
   * changé depuis le dernier calcul de `name` (ou au premier appel).
   */
  get<T>(name: string, deps: readonly unknown[], compute: () => T): T;
  /** Oublie toutes les valeurs (ex. : destruction de la page). */
  clear(): void;
}

interface Entry {
  deps: readonly unknown[];
  value: unknown;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

export function createDerivedCache(): DerivedCache {
  const entries = new Map<string, Entry>();
  return {
    get<T>(name: string, deps: readonly unknown[], compute: () => T): T {
      const hit = entries.get(name);
      if (hit && sameDeps(hit.deps, deps)) return hit.value as T;
      const value = compute();
      entries.set(name, { deps: [...deps], value });
      return value;
    },
    clear(): void {
      entries.clear();
    },
  };
}

/** Clé du jour local (« 2026-11-26 ») : dépendance des calculs relatifs à aujourd'hui. */
export function localDayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}
