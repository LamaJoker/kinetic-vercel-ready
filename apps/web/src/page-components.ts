/**
 * Composants Alpine des pages, chargés à la demande avec leur gabarit HTML.
 *
 * Avant, main.ts importait toutes les pages (Séances, Profil, Mensurations…) :
 * leur JS faisait partie du démarrage même pour n'afficher que l'accueil. Ici,
 * le routeur charge le module d'une page EN MÊME TEMPS que son gabarit, puis
 * l'enregistre (Alpine.data) avant d'injecter le HTML : aucun aller-retour de
 * plus, et le démarrage ne contient plus que le shell (index.html).
 *
 * Ajouter une page : une entrée ici (clé = valeur de ROUTES dans router.ts),
 * jamais d'import statique de la page dans main.ts.
 */

/** Fabrique de composant Alpine (même forme que le 2e argument d'Alpine.data). */
type ComponentFactory = (...args: never[]) => unknown;
type ComponentMap = Record<string, ComponentFactory>;

/** Glossaire en popover (ⓘ), utilisé par les pages qui l'affichent. */
const helpTip = (): Promise<ComponentMap> =>
  import('./components/help-tip').then((m) => ({ helpTip: m.helpTip }));

export const PAGE_COMPONENTS: Record<string, () => Promise<ComponentMap>> = {
  './pages/dashboard.html': () =>
    import('./pages/dashboard.page').then((m) => ({ dashboard: m.dashboard })),
  './pages/onboarding.html': () =>
    import('./pages/onboarding.page').then((m) => ({ onboarding: m.onboarding })),
  './pages/seances.html': () =>
    Promise.all([import('./pages/seances.page'), helpTip()]).then(([m, h]) => ({
      seances: m.seances,
      ...h,
    })),
  './pages/nutrition.html': () =>
    import('./pages/nutrition.page').then((m) => ({ nutrition: m.nutrition })),
  './pages/program.html': () =>
    import('./pages/program.page').then((m) => ({ program: m.program })),
  './pages/profile.html': () =>
    import('./pages/profile.page').then((m) => ({ profile: m.profile })),
  './pages/auth-callback.html': () =>
    import('./pages/auth-callback.page').then((m) => ({ authCallback: m.authCallback })),
  './pages/bodyweight.html': () =>
    import('./pages/bodyweight.page').then((m) => ({ bodyweight: m.bodyweight })),
  './pages/progression.html': () =>
    import('./pages/progression.page').then((m) => ({ progression: m.progression })),
  './pages/mensurations.html': () =>
    import('./pages/mensurations.page').then((m) => ({ mensurations: m.mensurations })),
  './pages/records.html': () =>
    Promise.all([import('./pages/records.page'), helpTip()]).then(([m, h]) => ({
      records: m.records,
      ...h,
    })),
  './pages/plates.html': () => import('./pages/plates.page').then((m) => ({ plates: m.plates })),
  './pages/achievements.html': () =>
    import('./pages/achievements.page').then((m) => ({ achievements: m.achievements })),
  './pages/photos.html': () =>
    import('./pages/photos.page').then((m) => ({ photosPage: m.photosPage })),
  './pages/programs.html': () =>
    import('./pages/programs.page').then((m) => ({ programsPage: m.programsPage })),
  './pages/glossaire.html': () =>
    import('./pages/glossaire.page').then((m) => ({ glossairePage: m.glossairePage })),
  './pages/template-editor.html': () =>
    import('./pages/template-editor.page').then((m) => ({ templateEditor: m.templateEditor })),
};

type Register = (name: string, factory: ComponentFactory) => void;

const loaded = new Map<string, Promise<void>>();

/**
 * Charge et enregistre (une seule fois) les composants d'un gabarit de page.
 * Sans entrée (vitalité, connexion, pages légales) : rien à charger. En cas
 * d'échec (hors-ligne, chunk disparu), l'essai suivant recommence.
 */
export function loadPageComponents(
  file: string,
  register: Register,
  loaders: Record<string, () => Promise<ComponentMap>> = PAGE_COMPONENTS,
): Promise<void> {
  const load = loaders[file];
  if (!load) return Promise.resolve();
  let pending = loaded.get(file);
  if (!pending) {
    pending = load().then((components) => {
      for (const [name, factory] of Object.entries(components)) register(name, factory);
    });
    pending.catch(() => loaded.delete(file));
    loaded.set(file, pending);
  }
  return pending;
}

/** Tests uniquement. */
export function _resetPageComponentsForTesting(): void {
  loaded.clear();
}
