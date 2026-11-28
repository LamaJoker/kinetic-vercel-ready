/**
 * Connexions IndexedDB de la page (docs/architecture/sync.md § 4.11 bis).
 *
 * Avant une navigation pleine page voulue par l'app (démo, restauration, déconnexion…) et
 * quand la page est quittée (`pagehide`, `freeze`), les connexions sont FERMÉES : une page
 * qui part (déchargement, cache de retour arrière) en gardant une connexion ou une écriture
 * en cours peut retenir la base de la page suivante (WebKit).
 *
 * Fermer n'est qu'une SUSPENSION : la connexion est rouverte au prochain accès. `close()`
 * d'IndexedDB laisse les transactions déjà créées aller à leur terme (aucune écriture
 * perdue) ; attendre leur fin avant de naviguer évite qu'un déchargement ne les annule.
 */

/** Ressource IndexedDB suspendable (connexion rouverte au prochain accès). */
export interface SuspendableConnection {
  /** Attend au plus `waitMs` la fin des écritures en cours (0 : aucune attente), puis ferme. */
  suspend(waitMs: number): Promise<void>;
  /** Connexion (r)ouverte ou en cours d'ouverture, ou écriture en cours. */
  active?(): boolean;
}

/** Délai d'observation après une fermeture : une écriture lancée juste après rouvre la base. */
const QUIET_MS = 25;

const live = new Set<SuspendableConnection>();

/** Inscrit une connexion (fermée par `closeAllLocalDatabases`) ; renvoie le retrait. */
export function trackConnection(connection: SuspendableConnection): () => void {
  live.add(connection);
  return () => live.delete(connection);
}

/** Attente bornée de promesses (jamais de rejet). */
export function settleWithin(pending: Iterable<Promise<unknown>>, ms: number): Promise<void> {
  const all = [...pending];
  if (all.length === 0 || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void Promise.allSettled(all).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Ferme TOUTES les connexions inscrites (base du compte, repli, images) après au plus
 * `waitMs` d'attente des écritures en cours. Ne rejette jamais. Avec `waitMs: 0`, les
 * fermetures sont faites de façon synchrone (gestionnaire de `pagehide`).
 */
export async function closeAllLocalDatabases(opts: { waitMs?: number } = {}): Promise<void> {
  const waitMs = opts.waitMs ?? 3000;
  const deadline = Date.now() + waitMs;
  let round = [...live];
  for (;;) {
    const left = Math.max(0, deadline - Date.now());
    const jobs = round.map((c) => {
      try {
        return c.suspend(left);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    for (const r of await Promise.allSettled(jobs)) {
      if (r.status === 'rejected') console.warn('[idb] fermeture de connexion :', r.reason);
    }
    if (left <= 0) return;
    // La page qui part réagit encore (rendu, écriture enchaînée, réouverture en cours) :
    // base rouverte pendant la fermeture → attendue et refermée, dans la limite du délai.
    await new Promise((r) => setTimeout(r, Math.min(QUIET_MS, left)));
    round = [...live].filter((c) => c.active?.() === true);
    if (round.length === 0) return;
  }
}

interface LifecycleTargets {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document?: Pick<Document, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * Page quittée ou gelée : connexions fermées tout de suite (aucune attente possible dans
 * ces événements ; les écritures déjà lancées vont à leur terme). Renvoie le retrait.
 */
export function closeLocalDatabasesOnPageHide(targets: LifecycleTargets): () => void {
  const onHide = (): void => void closeAllLocalDatabases({ waitMs: 0 });
  targets.window.addEventListener('pagehide', onHide);
  targets.document?.addEventListener('freeze', onHide);
  return () => {
    targets.window.removeEventListener('pagehide', onHide);
    targets.document?.removeEventListener('freeze', onHide);
  };
}
