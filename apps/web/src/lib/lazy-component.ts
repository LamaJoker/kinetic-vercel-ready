/**
 * Composants Alpine imbriqués chargés à la demande (calendrier, carte des
 * muscles…) : le module arrive par import() au premier besoin, puis est
 * enregistré une seule fois avec Alpine.data AVANT que son gabarit
 * (`<template x-if="…Ready">`) ne soit inséré. Rien au démarrage, rien non plus
 * au chargement de la page qui les accueille.
 */
type Factory = (...args: never[]) => unknown;
type Register = (name: string, factory: Factory) => void | Promise<void>;

/**
 * Nom Alpine (x-data) → import du composant. Une page qui utilise l'un d'eux
 * l'insère dans un `<template x-if>` ouvert seulement après `load…()`
 * (vérifié par tests/unit/page-components.test.ts).
 */
export const LAZY_COMPONENTS: Record<string, () => Promise<Factory>> = {
  trainingCalendar: () => import('../components/training-calendar').then((m) => m.trainingCalendar),
  muscleMap: () => import('../components/muscle-map').then((m) => m.muscleMap),
  strengthGoals: () => import('../components/strength-goals').then((m) => m.strengthGoals),
  weekPlan: () => import('../components/week-plan').then((m) => m.weekPlan),
  formCheckin: () => import('../components/wellness').then((m) => m.formCheckin),
  waterTracker: () => import('../components/wellness').then((m) => m.waterTracker),
  challengesPanel: () => import('../components/challenges').then((m) => m.challengesPanel),
  challengeCard: () => import('../components/challenges').then((m) => m.challengeCard),
};

const loaded = new Map<string, Promise<void>>();

/**
 * Alpine est déjà chargé (démarrage) : import() ne coûte rien ici, et évite
 * qu'importer une page (tests sous Node) n'exécute Alpine.
 */
const alpineRegister: Register = (name, factory) =>
  import('alpinejs').then((m) => m.default.data(name, factory as never));

/** Charge et enregistre `name` ; un échec (hors-ligne) permet un nouvel essai. */
export function loadLazyComponent(
  name: string,
  load: () => Promise<Factory> = () => {
    const loader = LAZY_COMPONENTS[name];
    return loader ? loader() : Promise.reject(new Error(`Composant inconnu : ${name}`));
  },
  register: Register = alpineRegister,
): Promise<void> {
  let pending = loaded.get(name);
  if (!pending) {
    pending = load().then((factory) => register(name, factory));
    pending.catch(() => loaded.delete(name));
    loaded.set(name, pending);
  }
  return pending;
}

/** Calendrier du mois (Séances › Historique). */
export function loadTrainingCalendar(): Promise<void> {
  return loadLazyComponent('trainingCalendar');
}

/** Carte des muscles (Progression › Muscles, aperçu de l'accueil). */
export function loadMuscleMap(): Promise<void> {
  return loadLazyComponent('muscleMap');
}

/** Objectifs de force (Progression, aperçu de l'accueil). */
export function loadStrengthGoals(): Promise<void> {
  return loadLazyComponent('strengthGoals');
}

/** Planning de la semaine du programme suivi (accueil, /program). */
export function loadWeekPlan(): Promise<void> {
  return loadLazyComponent('weekPlan');
}

/** Forme du jour et eau (accueil). */
export function loadWellness(): Promise<void> {
  return Promise.all([loadLazyComponent('formCheckin'), loadLazyComponent('waterTracker')]).then(
    () => undefined,
  );
}

/** Défis : section de la page Succès. */
export function loadChallengesPanel(): Promise<void> {
  return loadLazyComponent('challengesPanel');
}

/** Défis : carte compacte de l'accueil. */
export function loadChallengeCard(): Promise<void> {
  return loadLazyComponent('challengeCard');
}

/** Tests uniquement. */
export function _resetLazyComponentsForTesting(): void {
  loaded.clear();
}
