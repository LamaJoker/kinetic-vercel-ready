/**
 * Défis : lecture des données (séances, check-ins, eau), évaluation, et
 * récompense des défis réussis — célébration + XP bonus modérée, accordée
 * une seule fois (awardXp avec la clé `challengeAwardKey`, plus la liste
 * `completed` du stockage). Logique dans @kinetic/core (challenges.domain).
 *
 * Chargé à la demande : composants « Défis » (Succès, accueil) et, après une
 * séance enregistrée ou un check-in, par l'écouteur posé dans main.ts.
 */
import {
  STORAGE_KEYS,
  activeDefs,
  awardXp,
  challengeAwardKey,
  createCustomChallenge,
  evaluateChallenge,
  normalizeChallengeStore,
  pruneAccepted,
  recordCompleted,
  suggestedChallenges,
  waterGoal,
  type ChallengeContext,
  type ChallengeDef,
  type ChallengeProgress,
  type ChallengeStore,
  type CompletedChallenge,
  type CustomChallengeInput,
  type StoragePort,
  type WaterPrefs,
  currentBodyweightKg,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadExercises, loadSessions } from './training/storage';
import type { Exercise } from './training/types';
import { announceLevelUp, celebrate, challengeCelebration, highestLevelUp } from './celebration';

export interface ChallengeSnapshot {
  progress: ChallengeProgress[];
  suggestions: ChallengeDef[];
  completed: CompletedChallenge[];
  store: ChallengeStore;
  exercises: Exercise[];
}

async function readContext(
  storage: StoragePort,
  now: Date,
): Promise<{ ctx: ChallengeContext; store: ChallengeStore; exercises: Exercise[] }> {
  const [sessions, exercises, raw, checkins, water, prefs, profile, entries] = await Promise.all([
    loadSessions(storage),
    loadExercises(storage),
    storage.get(STORAGE_KEYS.CHALLENGES),
    storage.get<Record<string, unknown>>(STORAGE_KEYS.WELLNESS_CHECKINS),
    storage.get<Record<string, number[]>>(STORAGE_KEYS.WELLNESS_WATER),
    storage.get<WaterPrefs>(STORAGE_KEYS.WELLNESS_WATER_PREFS),
    storage.get<{ weightKg?: number }>(STORAGE_KEYS.USER_PROFILE),
    storage.get<Array<{ weight?: number }>>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
  ]);
  const w = currentBodyweightKg(entries) ?? Number(profile?.weightKg);
  const names = new Map(exercises.map((e) => [e.id, e.name]));
  return {
    ctx: {
      data: {
        sessions,
        checkinDays: checkins && typeof checkins === 'object' ? Object.keys(checkins) : [],
        water: water && typeof water === 'object' ? water : {},
      },
      now,
      nameOf: (id) => names.get(id) ?? id,
      waterGoalMl: waterGoal(prefs && typeof prefs === 'object' ? prefs : {}, w > 0 ? w : null),
    },
    store: normalizeChallengeStore(raw),
    exercises,
  };
}

const notify = (message: string, kind = 'success'): void => {
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind, message } }));
};

/** Une évaluation à la fois : deux appels rapprochés ne récompensent pas deux fois. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Évalue les défis en cours, enregistre et récompense ceux qui viennent
 * d'être réussis (célébration, +XP), puis renvoie l'état pour l'affichage.
 */
export function refreshChallenges(now: Date = new Date()): Promise<ChallengeSnapshot> {
  return serialized(async () => {
    const deps = await getDeps();
    const { ctx, store: stored, exercises } = await readContext(deps.storage, now);
    const defs = activeDefs(ctx, stored);
    const progress = defs.map((d) => evaluateChallenge(d, ctx.data, now));
    const pruned = pruneAccepted(stored, now);
    const { store, newly } = recordCompleted(pruned, progress, now.toISOString());
    if (store !== stored) await deps.storage.set(STORAGE_KEYS.CHALLENGES, store);

    const results = [];
    for (const c of newly) {
      const result = await awardXp(
        { storage: deps.storage, notifier: deps.notifier },
        { amount: c.xp, idempotencyKey: challengeAwardKey(c), silent: true },
      );
      results.push(result);
      const p = progress.find((x) => x.def.id === c.id);
      celebrate(challengeCelebration(p?.title ?? c.title, c.emoji, c.xp));
    }
    if (newly.length) {
      window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_XP_UPDATED));
      announceLevelUp(highestLevelUp(results));
    }
    return {
      progress,
      suggestions: suggestedChallenges(ctx, defs),
      completed: [...store.completed].reverse(),
      store,
      exercises,
    };
  });
}

/** Accepte un défi proposé. */
export function acceptChallenge(def: ChallengeDef): Promise<void> {
  return serialized(async () => {
    const deps = await getDeps();
    const store = normalizeChallengeStore(await deps.storage.get(STORAGE_KEYS.CHALLENGES));
    if (store.accepted.some((d) => d.id === def.id)) return;
    await deps.storage.set(STORAGE_KEYS.CHALLENGES, {
      ...store,
      accepted: [...store.accepted, def],
    });
  });
}

/** Abandonne un défi accepté ou personnel (les défis automatiques restent). */
export function dropChallenge(id: string): Promise<void> {
  return serialized(async () => {
    const deps = await getDeps();
    const store = normalizeChallengeStore(await deps.storage.get(STORAGE_KEYS.CHALLENGES));
    await deps.storage.set(STORAGE_KEYS.CHALLENGES, {
      ...store,
      accepted: store.accepted.filter((d) => d.id !== id),
    });
  });
}

/** Crée un défi personnel ; renvoie le message d'erreur à afficher, ou ''. */
export function createChallenge(input: CustomChallengeInput, now = new Date()): Promise<string> {
  return serialized(async () => {
    const deps = await getDeps();
    const store = normalizeChallengeStore(await deps.storage.get(STORAGE_KEYS.CHALLENGES));
    const id = `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const res = createCustomChallenge(input, now, store.accepted, id);
    if ('error' in res) return res.error;
    await deps.storage.set(STORAGE_KEYS.CHALLENGES, {
      ...store,
      accepted: [...store.accepted, res.def],
    });
    notify('Défi créé');
    return '';
  });
}
