/**
 * Schémas d'exercices : fichiers statiques `public/exercises/<nom>.svg`
 * (générés par scripts/generate-exercise-illustrations.mjs), téléchargés au
 * premier affichage puis gardés en mémoire. Rien dans le JS initial : ce
 * module n'est importé que par la page Séances.
 *
 * Le SVG est inséré dans la page (directive x-svg, liste fermée d'éléments)
 * pour que exercise-illustrations.css (.k-ill) lui applique les couleurs du thème. Pas
 * d'illustration → chaîne vide, rien n'est affiché.
 */
import './exercise-illustrations.css';

/** Identifiant d'exercice du catalogue → nom du schéma. */
export const EXERCISE_ILLUSTRATIONS: Readonly<Record<string, string>> = {
  // Jambes
  sq: 'squat',
  box_sq: 'squat',
  pause_sq: 'squat',
  fsq: 'front-squat',
  gobsquat: 'goblet-squat',
  lunges: 'lunge',
  rev_lunge: 'lunge',
  bss: 'bulgarian-split-squat',
  legpress: 'leg-press',
  legcurl: 'leg-curl',
  legext: 'leg-extension',
  calfraise: 'calf-raise',
  hipthrust: 'hip-thrust',
  // Poussée
  bp: 'bench-press',
  cgbp: 'bench-press',
  ibp: 'incline-press',
  dbbp: 'dumbbell-bench',
  ohp: 'overhead-press',
  pushpress: 'overhead-press',
  db_ohp: 'dumbbell-press',
  arnold: 'dumbbell-press',
  dip: 'dips',
  ring_dip: 'dips',
  pushup: 'push-up',
  latraise: 'lateral-raise',
  cableleraise: 'lateral-raise',
  // Tirage
  dl: 'deadlift',
  rack_pull: 'deadlift',
  rdl: 'romanian-deadlift',
  pullup: 'pull-up',
  ctb: 'pull-up',
  lat: 'lat-pulldown',
  row: 'barbell-row',
  pendlay: 'barbell-row',
  sarow: 'one-arm-row',
  cableRow: 'seated-row',
  facepull: 'face-pull',
  pullover: 'pullover',
  // Bras
  curl: 'curl',
  hammercurl: 'curl',
  triext: 'triceps-pushdown',
  skull: 'skull-crusher',
  ohtriext: 'overhead-triceps',
  // Gainage
  plank: 'plank',
  hangingLeg: 'hanging-leg-raise',
};

/** Nom du schéma d'un exercice, ou null s'il n'en a pas. */
export function illustrationName(exerciseId: string | null | undefined): string | null {
  if (!exerciseId) return null;
  return Object.prototype.hasOwnProperty.call(EXERCISE_ILLUSTRATIONS, exerciseId)
    ? EXERCISE_ILLUSTRATIONS[exerciseId]!
    : null;
}

export function hasIllustration(exerciseId: string | null | undefined): boolean {
  return illustrationName(exerciseId) !== null;
}

/** URL publique du schéma (servi tel quel, hors bundle). */
export function illustrationUrl(name: string): string {
  return `/exercises/${name}.svg`;
}

type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; headers: { get(n: string): string | null }; text(): Promise<string> }>;

const cache = new Map<string, Promise<string>>();

/**
 * Texte SVG du schéma (mémorisé). Refuse ce qui n'est pas un SVG (page de
 * repli HTML d'un déploiement, erreur) ; un échec permet un nouvel essai.
 */
export function loadIllustration(
  name: string,
  fetcher: Fetcher = (url) => fetch(url),
): Promise<string> {
  let pending = cache.get(name);
  if (!pending) {
    pending = fetcher(illustrationUrl(name)).then(async (res) => {
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || /text\/html/i.test(type)) throw new Error(`Schéma indisponible : ${name}`);
      const text = await res.text();
      if (!/^\s*<svg[\s>]/i.test(text)) throw new Error(`Schéma invalide : ${name}`);
      return text;
    });
    pending.catch(() => cache.delete(name));
    cache.set(name, pending);
  }
  return pending;
}

/** Vide la mémoire (tests). */
export function clearIllustrationCache(): void {
  cache.clear();
  loaded.clear();
}

export interface IllustrationHost {
  illustrations: Record<string, string>;
  cues(exerciseId: string): unknown;
}

/** Schémas déjà arrivés (partagés entre les ouvertures successives de la page). */
const loaded = new Map<string, string>();

/**
 * État + méthodes mélangés au composant `seances` (`...exerciseIllustrations()`).
 * `illustrationSvg(id)` renvoie '' tant que le schéma n'est pas arrivé, puis
 * le texte SVG (la mise à jour de `illustrations` réaffiche le gabarit).
 */
export function exerciseIllustrations() {
  return {
    /** Schémas téléchargés pendant que la page est ouverte : nom → texte SVG. */
    illustrations: {} as Record<string, string>,

    hasIllustration(exerciseId: string): boolean {
      return hasIllustration(exerciseId);
    },

    /** Consignes ou schéma : le bouton « Comment exécuter ? » s'affiche. */
    hasGuide(this: IllustrationHost, exerciseId: string): boolean {
      return !!this.cues(exerciseId) || hasIllustration(exerciseId);
    },

    illustrationSvg(this: IllustrationHost, exerciseId: string | null | undefined): string {
      const name = illustrationName(exerciseId);
      if (!name) return '';
      const svg = this.illustrations[name] ?? loaded.get(name);
      if (svg) return svg;
      // Promesse mémorisée : plusieurs appels ne font qu'un téléchargement. Un
      // échec (hors-ligne) ne change rien à l'état : nouvel essai au prochain affichage.
      loadIllustration(name).then(
        (text) => {
          loaded.set(name, text);
          if (this.illustrations[name] !== text) {
            this.illustrations = { ...this.illustrations, [name]: text };
          }
        },
        () => undefined,
      );
      return '';
    },
  };
}
