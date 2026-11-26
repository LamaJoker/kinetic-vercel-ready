/**
 * demo.ts — jeu de données de démonstration (mode invité uniquement).
 *
 * Permet d'explorer Kinetic « rempli » sans rien saisir : 8 semaines de
 * Push/Pull/Legs avec surcharge progressive (sauf un plateau au développé
 * militaire), objectifs de force, pesées, mensurations, XP et série.
 * Déterministe (PRNG à graine fixe) et réversible : chaque clé écrite est listée
 * dans `DEMO_MANIFEST`, `clearDemoData()` retire exactement ces clés.
 */
import {
  STORAGE_KEYS,
  autoChallenges,
  evaluateChallenge,
  periodRange,
  recordCompleted,
  suggestedChallenges,
  type ChallengeData,
  type ChallengeDef,
  type StoragePort,
  type StorageKey,
} from '@kinetic/core';
import type { WorkoutSession, SetEntry } from './training/types';
import { DEFAULT_TEMPLATES } from './training/seed';
import { saveSession, sessionStorageKey } from './training/storage';
import { localIsoDate } from './training/next-session';
import { setCelebrationsMuted } from './celebration';

const DEMO_PHOTO_PREFIX = 'demo-photo-';
/** Préfixe des clés de séance (une clé par séance, cf. training/storage.ts). */
const SESSION_KEY_PREFIX = STORAGE_KEYS.TRAINING_SESSION_PREFIX;

/** Charges de départ (kg) et incrément toutes les 2 semaines. */
const START_KG: Record<string, [number, number]> = {
  bp: [72.5, 2.5],
  ohp: [45, 1.25],
  dip: [0, 2.5],
  row: [65, 2.5],
  lat: [55, 2.5],
  curl: [14, 1],
  sq: [90, 5],
  legpress: [160, 10],
  dl: [120, 5],
  ibp: [60, 2.5],
  dbbp: [28, 2],
  fly: [15, 1.25],
  latraise: [9, 1],
  triext: [25, 1.25],
  pullup: [0, 2.5],
  cableRow: [55, 2.5],
  facepull: [20, 1.25],
  hammercurl: [16, 1],
  rdl: [90, 5],
  legcurl: [40, 2.5],
  calfraise: [80, 5],
  hipthrust: [100, 5],
};

/** Charge figée (plateau) : le développé militaire stagne, pour montrer l'alerte de plateau. */
const PLATEAU_IDS = new Set(['ohp']);

const ROTATION = [
  'tpl-push-a',
  'tpl-pull-a',
  'tpl-legs-a',
  'tpl-push-b',
  'tpl-pull-b',
  'tpl-legs-b',
];
/** Jours d'entraînement : lundi, mardi, jeudi, samedi (0 = lundi). */
const TRAINING_WEEKDAYS = [0, 1, 3, 5];
const WEEKS = 8;
const DEMO_DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const DEMO_MUSCLES: Record<'push' | 'pull' | 'legs', string[]> = {
  push: ['pectoraux', 'épaules', 'triceps'],
  pull: ['dos', 'biceps', 'trapèzes'],
  legs: ['quadriceps', 'ischio', 'mollets', 'fessiers'],
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundTo(x: number, step: number): number {
  return Math.round(x / step) * step;
}

export interface DemoDataset {
  sessions: WorkoutSession[];
  values: Array<[StorageKey, unknown]>;
}

/** Construit le jeu de données, sans rien écrire. `now` = référence temporelle. */
export function buildDemoData(now: Date = new Date()): DemoDataset {
  const rand = mulberry32(20260927);
  const templates = new Map(DEFAULT_TEMPLATES.map((t) => [t.id, t]));

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayThisWeek = new Date(today);
  mondayThisWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const firstMonday = new Date(mondayThisWeek);
  firstMonday.setDate(mondayThisWeek.getDate() - 7 * (WEEKS - 1));

  const sessions: WorkoutSession[] = [];
  let rotationIndex = 0;

  /** Rang dans la rotation au lundi de la semaine en cours (programme de démo). */
  let weekStartRotation = 0;

  for (let w = 0; w < WEEKS; w++) {
    if (w === WEEKS - 1) weekStartRotation = rotationIndex;
    for (const wd of TRAINING_WEEKDAYS) {
      const day = new Date(firstMonday);
      day.setDate(firstMonday.getDate() + w * 7 + wd);
      if (day >= today) continue; // rien aujourd'hui ni dans le futur
      if (w > 0 && rand() < 0.08) continue; // une séance manquée de temps en temps

      const tpl = templates.get(ROTATION[rotationIndex % ROTATION.length]!)!;
      rotationIndex++;
      const hour = wd === 5 ? 10 : 18;
      const start = new Date(day);
      start.setHours(hour, Math.floor(rand() * 40), 0, 0);
      let t = start.getTime() + 5 * 60_000;

      const entries = tpl.exercises.map((ex) => {
        const [base, inc] = START_KG[ex.exerciseId] ?? [20, 2.5];
        const load = PLATEAU_IDS.has(ex.exerciseId) ? base : base + inc * Math.floor(w / 2);
        const sets: SetEntry[] = [];
        for (let i = 0; i < ex.sets; i++) {
          const fatigue = i >= ex.sets - 1 ? 1 : 0;
          // Poids du corps : la progression passe par les reps (+1 toutes les 3 semaines).
          const extra = base === 0 ? Math.floor(w / 3) : 0;
          const reps = Math.max(3, ex.targetReps + extra - fatigue - (rand() < 0.2 ? 1 : 0));
          t += (90 + Math.floor(rand() * 60)) * 1000;
          sets.push({
            setIndex: i,
            reps,
            weightKg: base === 0 ? 0 : roundTo(load, inc >= 1 ? 0.5 : 0.25),
            rpe: Math.min(10, 7 + fatigue + (rand() < 0.3 ? 0.5 : 0)),
            performedAt: new Date(t).toISOString(),
          });
        }
        return { exerciseId: ex.exerciseId, sets };
      });

      const end = new Date(t + 4 * 60_000);
      sessions.push({
        id: `demo-${localIsoDate(day)}`,
        name: tpl.name,
        templateId: tpl.id,
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        entries,
        durationMin: Math.round((end.getTime() - start.getTime()) / 60_000),
      });
    }
  }

  // Quelques notes de séries (historique, bilan PDF) : sans tirage aléatoire,
  // pour ne rien changer au reste du jeu de données.
  const notes: Array<[number, string]> = [
    [2, 'Dernière série dure, garder la charge la prochaine fois'],
    [6, 'Descente plus lente : technique bien plus propre'],
    [11, 'Petite gêne au genou droit à l’échauffement, disparue ensuite'],
  ];
  for (const [back, note] of notes) {
    const set = sessions[sessions.length - back]?.entries[0]?.sets[1];
    if (set) set.note = note;
  }

  // Pesées : 3 par semaine, de ~79,4 kg vers ~77,6 kg
  // Marquées `demo` (les pesées n'ont pas d'identifiant) : une vraie pesée saisie pendant
  // la démo est gardée quand on la quitte.
  const bodyweight: Array<{
    date: string;
    weight: number;
    bodyFatPct: number | null;
    note: string | null;
    demo: true;
  }> = [];
  for (let d = WEEKS * 7; d >= 0; d -= 2) {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const progress = 1 - d / (WEEKS * 7);
    const weight = 79.4 - 1.8 * progress + (rand() - 0.5) * 0.6;
    bodyweight.push({
      date: localIsoDate(day),
      weight: Math.round(weight * 10) / 10,
      bodyFatPct: d % 14 === 0 ? Math.round((17.5 - 1.5 * progress) * 10) / 10 : null,
      note: null,
      demo: true,
    });
  }
  const lightWeek = bodyweight[bodyweight.length - 4];
  if (lightWeek) lightWeek.note = 'Semaine de décharge, sommeil un peu court';

  // Mensurations toutes les 2 semaines : cou + taille (+ hanches) donnent la courbe
  // de masse grasse estimée (méthode US Navy) dans Mensurations et Poids.
  const measurements = [WEEKS * 7, 42, 28, 14, 0].map((d, i) => {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      id: `demo-m${i}`,
      date: localIsoDate(day),
      neck: r(37.6 + i * 0.1),
      chest: r(101 + i * 0.4),
      waist: r(84.6 - i * 0.6),
      hips: r(97 - i * 0.2),
      leftBicep: r(36 + i * 0.2),
      rightBicep: r(36.3 + i * 0.2),
      shoulders: r(118 + i * 0.35),
      leftThigh: r(58 + i * 0.15),
      rightThigh: r(58.2 + i * 0.15),
    };
  });

  // Photos de progrès (silhouettes) : 2 poses, pour le comparateur avant / après.
  const demoPhotos = (
    [
      [WEEKS * 7, 'front', 56],
      [WEEKS * 7 - 1, 'side', 56],
      [28, 'front', 50],
      [0, 'front', 45],
    ] as const
  ).map(([d, label, waist], i) => {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    day.setHours(8, 0, 0, 0);
    return {
      id: `${DEMO_PHOTO_PREFIX}${i}`,
      takenAt: day.toISOString(),
      label,
      dataUrl: demoPhotoDataUrl(waist, label),
    };
  });

  const nowIso = now.toISOString();
  const food = (name: string, kcal: number, p: number, c: number, f: number) => ({
    name,
    kcalPer100: kcal,
    proteinPer100: p,
    carbsPer100: c,
    fatPer100: f,
  });
  const meal = (
    id: string,
    mealName: string,
    hour: number,
    items: Array<[ReturnType<typeof food>, number]>,
    day: Date = today,
  ) => {
    const at = new Date(day);
    at.setHours(hour, 15, 0, 0);
    return {
      id,
      mealName,
      loggedAt: at.toISOString(),
      items: items.map(([f, grams]) => ({ food: f, grams })),
    };
  };
  const oats = food("Flocons d'avoine", 372, 13.5, 58.7, 7);
  const skyr = food('Skyr nature', 63, 11, 4, 0.2);
  const banana = food('Banane', 89, 1.1, 22.8, 0.3);
  const rice = food('Riz basmati cuit', 130, 2.7, 28, 0.3);
  const chicken = food('Blanc de poulet', 110, 23, 0, 1.5);
  const oil = food("Huile d'olive", 884, 0, 0, 100);
  const whey = food('Whey protéine', 380, 78, 8, 5);
  const eggs = food('Œufs entiers', 143, 12.6, 0.7, 9.5);
  const milk = food('Lait demi-écrémé', 46, 3.3, 4.8, 1.6);
  const todayMeals = [
    meal('demo-meal-1', 'Matin', 8, [
      [oats, 80],
      [skyr, 250],
      [banana, 120],
    ]),
    meal('demo-meal-2', 'Déjeuner', 13, [
      [rice, 220],
      [chicken, 180],
      [oil, 10],
    ]),
  ];
  // Hier : de quoi « Copier le repas d'hier » (collation et dîner pas encore notés aujourd'hui).
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayMeals = [
    meal(
      'demo-meal-y1',
      'Matin',
      8,
      [
        [oats, 80],
        [skyr, 250],
        [banana, 120],
      ],
      yesterday,
    ),
    meal(
      'demo-meal-y2',
      'Déjeuner',
      13,
      [
        [rice, 200],
        [chicken, 160],
      ],
      yesterday,
    ),
    meal(
      'demo-meal-y3',
      'Collation',
      17,
      [
        [whey, 30],
        [milk, 250],
      ],
      yesterday,
    ),
    meal(
      'demo-meal-y4',
      'Dîner',
      20,
      [
        [eggs, 180],
        [rice, 150],
        [oil, 10],
      ],
      yesterday,
    ),
  ];
  // Récents (dernière quantité), favoris épinglés et deux recettes.
  const usedAt = (daysAgo: number, hour: number) => {
    const at = new Date(today);
    at.setDate(today.getDate() - daysAgo);
    at.setHours(hour, 15, 0, 0);
    return at.toISOString();
  };
  const nutritionRecents = [
    { food: chicken, grams: 180, usedAt: usedAt(0, 13) },
    { food: rice, grams: 220, usedAt: usedAt(0, 13) },
    { food: oil, grams: 10, usedAt: usedAt(0, 13) },
    { food: banana, grams: 120, usedAt: usedAt(0, 8) },
    { food: skyr, grams: 250, usedAt: usedAt(0, 8) },
    { food: oats, grams: 80, usedAt: usedAt(0, 8) },
    { food: eggs, grams: 180, usedAt: usedAt(1, 20) },
    { food: milk, grams: 250, usedAt: usedAt(1, 17) },
    { food: whey, grams: 30, usedAt: usedAt(1, 17) },
  ];
  const nutritionFavorites = [skyr, whey, chicken];
  const nutritionRecipes = [
    {
      id: 'demo-recipe-bowl',
      name: 'Bowl poulet riz',
      servings: 2,
      ingredients: [
        { food: chicken, grams: 300 },
        { food: rice, grams: 400 },
        { food: oil, grams: 15 },
      ],
      updatedAt: usedAt(6, 19),
    },
    {
      id: 'demo-recipe-porridge',
      name: 'Porridge protéiné',
      servings: 1,
      ingredients: [
        { food: oats, grams: 70 },
        { food: milk, grams: 250 },
        { food: whey, grams: 30 },
        { food: banana, grams: 100 },
      ],
      updatedAt: usedAt(3, 8),
    },
  ];
  const lastTrained = sessions[sessions.length - 1];

  // Objectifs de force : en route (date estimée), tendance plate (plateau), atteint.
  const goalsSince = new Date(today);
  goalsSince.setDate(today.getDate() - 35);
  const createdAt = goalsSince.toISOString();
  const dlDone = sessions
    .flatMap((s) => s.entries.filter((e) => e.exerciseId === 'dl').flatMap((e) => e.sets))
    .find((set) => set.weightKg >= 130)?.performedAt;
  const strengthGoals = [
    { id: 'demo-goal-sq', exerciseId: 'sq', kind: 'weight', targetKg: 140, createdAt },
    { id: 'demo-goal-bp', exerciseId: 'bp', kind: 'reps', targetKg: 85, targetReps: 8, createdAt },
    { id: 'demo-goal-ohp', exerciseId: 'ohp', kind: 'e1rm', targetKg: 65, createdAt },
    {
      id: 'demo-goal-dl',
      exerciseId: 'dl',
      kind: 'weight',
      targetKg: 130,
      createdAt: new Date(firstMonday).toISOString(),
      ...(dlDone ? { achievedAt: dlDone } : {}),
    },
  ];
  // Programme suivi (semaine qui s'adapte) : les 4 jours de la démo, dans l'ordre de la
  // rotation. Le prochain jour d'entraînement (après aujourd'hui) est marqué indisponible : sa séance est
  // déplacée, pour montrer le planning de l'accueil et de /program.
  const todayIdx = (today.getDay() + 6) % 7;
  const programSchedule = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const slot = TRAINING_WEEKDAYS.indexOf(d);
    const tpl = templates.get(ROTATION[(weekStartRotation + slot) % ROTATION.length]!);
    const label = DEMO_DAY_LABELS[d]!;
    const dayOfWeek = (d + 1) % 7;
    if (slot < 0 || !tpl)
      return { dayOfWeek, label, focus: 'Repos', muscleGroups: [], restDay: true };
    const kind = tpl.id.includes('push') ? 'push' : tpl.id.includes('pull') ? 'pull' : 'legs';
    return { dayOfWeek, label, focus: tpl.name, muscleGroups: DEMO_MUSCLES[kind], restDay: false };
  });
  // Jamais aujourd'hui : la « Séance du jour » de l'accueil reste faisable.
  const nextSlot = TRAINING_WEEKDAYS.find((d) => d > todayIdx);
  const values: Array<[StorageKey, unknown]> = [
    [
      STORAGE_KEYS.USER_PROFILE,
      {
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        sex: 'male',
        ageYears: 29,
        heightCm: 180,
        weightKg: bodyweight[bodyweight.length - 1]!.weight,
        activity: 'moderate',
        goal: 'recomp',
      },
    ],
    [STORAGE_KEYS.BODYWEIGHT_ENTRIES, bodyweight],
    [STORAGE_KEYS.BODYWEIGHT_GOAL, 76],
    [STORAGE_KEYS.STRENGTH_GOALS, strengthGoals],
    [STORAGE_KEYS.MEASUREMENTS_ENTRIES, measurements],
    [STORAGE_KEYS.PROGRESS_PHOTOS, demoPhotos],
    [STORAGE_KEYS.XP, { xp: 2350 }],
    [
      STORAGE_KEYS.PROGRAM_ACTIVE,
      {
        id: 'demo-program',
        name: 'Push Pull Legs — 4 jours',
        splitType: 'ppl',
        daysPerWeek: TRAINING_WEEKDAYS.length,
        goal: 'hypertrophie',
        schedule: programSchedule,
        createdAt: firstMonday.toISOString(),
        active: true,
      },
    ],
    [
      STORAGE_KEYS.PROGRAM_WEEK_PLAN,
      {
        week: localIsoDate(mondayThisWeek),
        programId: 'demo-program',
        moves: {},
        skipped: [],
        unavailable: nextSlot === undefined ? [] : [nextSlot],
      },
    ],
    [STORAGE_KEYS.NUTRITION_LOG(localIsoDate(today)), todayMeals],
    [STORAGE_KEYS.NUTRITION_LOG(localIsoDate(yesterday)), yesterdayMeals],
    [STORAGE_KEYS.NUTRITION_RECENTS, nutritionRecents],
    [STORAGE_KEYS.NUTRITION_FAVORITES, nutritionFavorites],
    [STORAGE_KEYS.NUTRITION_RECIPES, nutritionRecipes],
    // Minuteurs HIIT : deux préréglages prêts à lancer (page Minuteurs)
    [
      STORAGE_KEYS.TIMER_PRESETS,
      [
        {
          id: 'demo-timer-tabata',
          name: 'Tabata burpees',
          config: {
            mode: 'tabata',
            workSec: 20,
            restSec: 10,
            rounds: 8,
            warmupSec: 0,
            cooldownSec: 0,
          },
        },
        {
          id: 'demo-timer-emom',
          name: 'EMOM kettlebell 12 min',
          config: {
            mode: 'emom',
            workSec: 60,
            restSec: 0,
            rounds: 12,
            warmupSec: 0,
            cooldownSec: 0,
          },
        },
      ],
    ],
    [
      STORAGE_KEYS.STREAK,
      {
        count: 4,
        best: 12,
        lastActiveDate: lastTrained ? localIsoDate(new Date(lastTrained.startedAt)) : null,
      },
    ],
  ];

  values.push(...demoWellness(today));
  values.push(demoChallenges(sessions, values, now));
  return { sessions, values };
}

/**
 * Forme du jour et eau : check-ins des 29 derniers jours (pas aujourd'hui, pour
 * que l'accueil propose le check-in en 3 touches) avec un creux il y a 4 jours,
 * et l'eau de la semaine (objectif atteint la plupart des jours, 3 verres ce matin).
 */
function demoWellness(today: Date): Array<[StorageKey, unknown]> {
  const rand = mulberry32(20261121);
  const sleeps = ['bad', 'ok', 'good'] as const;
  const checkins: Record<string, unknown> = {};
  for (let d = 29; d >= 1; d--) {
    if (d % 9 === 5) continue; // un oubli de temps en temps
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const dip = d === 4 || d === 5; // nuit courte et grosses courbatures
    const hours = dip ? 5.5 : Math.round((6.5 + rand() * 2) * 4) / 4;
    checkins[localIsoDate(day)] = {
      date: localIsoDate(day),
      sleep: sleeps[hours < 6 ? 0 : hours < 7 ? 1 : 2],
      sleepHours: hours,
      energy: dip ? 2 : 3 + Math.floor(rand() * 3),
      soreness: dip ? 'heavy' : rand() < 0.35 ? 'light' : 'none',
    };
  }
  const water: Record<string, number[]> = {};
  for (let d = 6; d >= 0; d--) {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const glasses = d === 0 ? 3 : d === 3 ? 7 : 11 + Math.floor(rand() * 2);
    water[localIsoDate(day)] = Array.from({ length: glasses }, () => 250);
  }
  return [
    [STORAGE_KEYS.WELLNESS_CHECKINS, checkins],
    [STORAGE_KEYS.WELLNESS_WATER, water],
  ];
}

/**
 * Défis : médailles des défis automatiques réussis ces dernières semaines et
 * ces derniers mois, et le défi « check-ins d'affilée » relevé ce mois-ci.
 * Les défis déjà réussis de la période en cours sont enregistrés comme tels :
 * pas de célébration en rafale à l'ouverture de la démo.
 */
function demoChallenges(
  sessions: readonly WorkoutSession[],
  values: ReadonlyArray<[StorageKey, unknown]>,
  now: Date,
): [StorageKey, unknown] {
  const read = (key: StorageKey) => values.find(([k]) => k === key)?.[1];
  const checkins = (read(STORAGE_KEYS.WELLNESS_CHECKINS) ?? {}) as Record<string, unknown>;
  const data: ChallengeData = {
    sessions,
    checkinDays: Object.keys(checkins),
    water: (read(STORAGE_KEYS.WELLNESS_WATER) ?? {}) as Record<string, number[]>,
  };
  const names: Record<string, string> = { pullup: 'Tractions', dip: 'Dips' };
  const nameOf = (id: string): string => names[id] ?? id;
  const ctx = { data, now, nameOf };
  const accepted = suggestedChallenges(ctx, autoChallenges(ctx)).filter(
    (d) => d.metric === 'checkinStreak',
  );
  const defs = new Map<string, ChallengeDef>(accepted.map((d) => [d.id, d]));
  for (let w = 0; w <= 5; w++) {
    const at = new Date(now);
    at.setDate(now.getDate() - 7 * w);
    for (const d of autoChallenges({ ...ctx, now: at })) defs.set(d.id, d);
  }
  for (let m = 1; m <= 2; m++) {
    const at = new Date(now.getFullYear(), now.getMonth() - m, 15, 12);
    for (const d of autoChallenges({ ...ctx, now: at })) defs.set(d.id, d);
  }
  const progress = [...defs.values()].map((d) => evaluateChallenge(d, data, now));
  const { store } = recordCompleted({ accepted, completed: [] }, progress, now.toISOString());
  // Date de réussite : fin de la période (ou maintenant pour la période en cours).
  const completed = store.completed.map((c) => {
    const end = periodRange(c.period, c.periodKey).end;
    const [y, m, d] = end.split('-').map(Number);
    const at = new Date(y!, m! - 1, d!, 19);
    return { ...c, completedAt: (at < now ? at : now).toISOString() };
  });
  return [STORAGE_KEYS.CHALLENGES, { ...store, completed }];
}

/**
 * Photo de progrès de démo : silhouette SVG (aucune vraie photo), plus fine à
 * la taille au fil des semaines. Stockée en data URL : lib/photos.ts la migre
 * vers son store d'images à la première lecture, comme une ancienne photo.
 */
export function demoPhotoDataUrl(waist: number, pose: 'front' | 'side'): string {
  const w = pose === 'side' ? waist * 0.62 : waist;
  const sh = pose === 'side' ? 44 : 78;
  const hip = pose === 'side' ? w + 6 : w + 10;
  const arms =
    pose === 'side'
      ? '<rect x="138" y="118" width="24" height="120" rx="12"/>'
      : `<rect x="${150 - sh - 20}" y="118" width="24" height="125" rx="12" transform="rotate(8 ${150 - sh} 118)"/>` +
        `<rect x="${150 + sh - 4}" y="118" width="24" height="125" rx="12" transform="rotate(-8 ${150 + sh} 118)"/>`;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3f55"/>' +
    '<stop offset="1" stop-color="#171a26"/></linearGradient></defs>' +
    '<rect width="300" height="400" fill="url(#g)"/><ellipse cx="150" cy="388" rx="90" ry="8" fill="#000" opacity=".35"/>' +
    '<g fill="#d9a48a"><circle cx="150" cy="62" r="27"/><rect x="138" y="84" width="24" height="26" rx="8"/>' +
    `<path d="M${150 - sh} 112 Q150 100 ${150 + sh} 112 L${150 + w} 230 L${150 + hip} 268 L${150 - hip} 268 L${150 - w} 230 Z"/>` +
    arms +
    `<rect x="${150 - hip + 2}" y="262" width="${hip - 6}" height="122" rx="16"/>` +
    `<rect x="154" y="262" width="${hip - 6}" height="122" rx="16"/></g>` +
    `<path d="M${150 - w - 3} 240 L${150 + w + 3} 240 L${150 + hip + 2} 292 L${150 - hip - 2} 292 Z" fill="#2b3350"/></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

/** Écrit le jeu de démo et mémorise les clés pour pouvoir le retirer. */
export async function loadDemoData(storage: StoragePort, now: Date = new Date()): Promise<number> {
  const { sessions, values } = buildDemoData(now);
  const written: StorageKey[] = [];
  // Alertes de plateau masquées pendant la démo (sur ses exercices) : parties avec
  // elle, sauf si l'utilisateur en avait déjà avant.
  if ((await storage.get(STORAGE_KEYS.PLATEAU_DISMISSED)) === null)
    written.push(STORAGE_KEYS.PLATEAU_DISMISSED);
  // Pas de pluie de records / niveaux pendant l'écriture des 8 semaines de démo.
  setCelebrationsMuted(true);
  try {
    for (const [key, value] of values) {
      await storage.set(key, value);
      written.push(key);
    }
    for (const s of sessions) {
      await saveSession(storage, s);
      written.push(sessionStorageKey(s.id));
    }
    await storage.set(STORAGE_KEYS.DEMO_MANIFEST, written);
  } finally {
    setCelebrationsMuted(false);
  }
  return sessions.length;
}

export async function isDemoActive(storage: StoragePort): Promise<boolean> {
  return Array.isArray(await storage.get(STORAGE_KEYS.DEMO_MANIFEST));
}

/** Identifiants des photos de démo (silhouettes SVG). */
export function isDemoPhotoId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(DEMO_PHOTO_PREFIX);
}

/**
 * Élément d'une liste écrit par la démo : identifiant `demo-…`, ou pesée marquée `demo`
 * (sans identifiant). Un élément sans identifiant d'une autre liste (récents, favoris)
 * est considéré comme venant de la démo.
 */
function isDemoItem(key: StorageKey, item: unknown, flagged: boolean): boolean {
  if (!item || typeof item !== 'object') return true;
  if (key === STORAGE_KEYS.BODYWEIGHT_ENTRIES) {
    // Démo chargée par une version antérieure (pesées non marquées) : toutes en viennent.
    return !flagged || (item as { demo?: unknown }).demo === true;
  }
  const id = (item as { id?: unknown }).id;
  return typeof id !== 'string' || id.startsWith('demo-');
}

/**
 * Retire une clé de la démo. Pour une liste (pesées, mensurations, repas, photos,
 * recettes…), seuls les éléments de la démo partent : ce que l'utilisateur a ajouté
 * pendant la démo (sa vraie pesée, son repas du jour) est gardé (audit F10). Les autres
 * valeurs (profil, niveau, série, programme) sont celles de la démo et partent entières.
 */
async function removeDemoKey(storage: StoragePort, key: StorageKey): Promise<void> {
  const value = await storage.get<unknown>(key);
  if (Array.isArray(value)) {
    const flagged = value.some(
      (item: unknown) => !!item && (item as { demo?: unknown }).demo === true,
    );
    const kept = value.filter((item: unknown) => !isDemoItem(key, item, flagged));
    if (kept.length > 0) {
      await storage.set(key, kept);
      return;
    }
  }
  await storage.remove(key);
}

/**
 * Retire ce que la démo a écrit, plus ce qu'elle laisse ailleurs : images des photos
 * de démo (base d'images du compte), alertes de plateau masquées pendant la démo,
 * séance commencée pendant la démo. Les saisies réelles faites pendant la démo dans
 * des listes sont gardées (removeDemoKey).
 */
export async function clearDemoData(storage: StoragePort): Promise<void> {
  const manifest = await storage.get<StorageKey[]>(STORAGE_KEYS.DEMO_MANIFEST);
  if (!Array.isArray(manifest)) return;
  // Images des photos de démo : la liste est lue avant d'effacer les métadonnées.
  const photos = await storage.get<Array<{ id?: unknown }>>(STORAGE_KEYS.PROGRESS_PHOTOS);
  const photoIds = (Array.isArray(photos) ? photos : []).map((p) => p?.id).filter(isDemoPhotoId);
  for (const key of manifest) await removeDemoKey(storage, key);
  // Une séance commencée pendant la démo porte sur ses modèles : elle part avec.
  await storage.remove(STORAGE_KEYS.TRAINING_ACTIVE_SESSION);
  // Démo chargée par une version antérieure (manifeste sans cette clé) : sans
  // aucune séance restante, un masquage d'alerte de plateau ne vient que d'elle.
  if (!manifest.includes(STORAGE_KEYS.PLATEAU_DISMISSED)) {
    const left = (await storage.keys()).some((k) => k.startsWith(SESSION_KEY_PREFIX));
    if (!left) await storage.remove(STORAGE_KEYS.PLATEAU_DISMISSED);
  }
  await storage.remove(STORAGE_KEYS.DEMO_MANIFEST);
  if (photoIds.length > 0) {
    try {
      const { deletePhotoBlobs } = await import('./photos');
      await deletePhotoBlobs(storage, photoIds);
    } catch (err) {
      console.warn('[demo] images des photos de démo non effacées :', err);
    }
  }
}
