/**
 * Téléchargement d'un gabarit de page émis en fichier statique au build
 * (plugin compactPageHtml de vite.config.ts). En dev, les gabarits restent des
 * chaînes (`?raw`) et ce module ne sert pas.
 */

/**
 * Renvoie une fonction qui télécharge le gabarit (une fois, puis le garde en
 * mémoire). Échoue si la réponse n'est pas le fichier attendu : erreur HTTP, ou
 * page HTML servie à sa place (repli SPA sur un fichier disparu après un
 * déploiement) — le routeur affiche alors son message « Impossible de charger ».
 */
export function pageTemplate(url: string): () => Promise<string> {
  // Promesse gardée : un préchargement (page d'arrivée, main.ts) et l'affichage
  // qui suit partagent le même téléchargement. Oubliée en cas d'échec (réessai).
  let pending: Promise<string> | null = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const resp = await fetch(url);
      const type = resp.headers.get('content-type') ?? '';
      if (!resp.ok || type.includes('text/html')) {
        throw new Error(`[page-template] ${url} : ${resp.status} ${type}`);
      }
      return resp.text();
    })();
    pending.catch(() => {
      pending = null;
    });
    return pending;
  };
}
