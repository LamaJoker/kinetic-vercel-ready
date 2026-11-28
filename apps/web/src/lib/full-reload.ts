/**
 * Navigation pleine page voulue par l'app (démo chargée, restauration, déconnexion,
 * stockage bloqué) — docs/architecture/sync.md § 4.11 bis.
 *
 * WebKit (iPhone) : une page qui part en gardant une connexion IndexedDB ou une écriture
 * en cours (déchargement, cache de retour arrière) peut retenir la base de la page
 * suivante, dont les ouvertures et lectures restent alors sans réponse. Avant de partir :
 *  1. les écritures en cours sont attendues (au plus `waitMs`) : le déchargement ne les
 *     annule pas, aucune donnée perdue ;
 *  2. toutes les connexions IndexedDB de la page sont fermées ;
 *  3. `location.replace` plutôt que `assign` : la page quittée n'a plus d'entrée
 *     d'historique, elle ne reste pas en cache de retour arrière.
 */
import { closeAllLocalDatabases } from '@kinetic/adapters-web';

/** Recharge l'app (`path` absent : la page courante) après fermeture des bases. */
export async function fullReload(path?: string, waitMs = 3000): Promise<void> {
  // Ne rejette jamais (erreurs de fermeture seulement journalisées).
  await closeAllLocalDatabases({ waitMs });
  if (path === undefined) window.location.reload();
  else window.location.replace(path);
}
