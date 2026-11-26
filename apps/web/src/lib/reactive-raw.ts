/**
 * Objet d'origine d'un proxy réactif d'Alpine (`Alpine.raw`, API publique) : parcourir
 * l'historique sans passer par le proxy évite son coût à chaque lecture (×10 mesuré
 * sur 2 000 séances, PERF-06) et n'ajoute aucune dépendance réactive par élément.
 *
 * Passe par `window.Alpine` (exposé par main.ts) plutôt qu'un import : les modules de
 * page restent utilisables sans Alpine (tests Node), où la valeur est déjà brute.
 */
export function rawOf<T>(value: T): T {
  const alpine = typeof window !== 'undefined' ? window.Alpine : undefined;
  return alpine ? alpine.raw(value) : value;
}
