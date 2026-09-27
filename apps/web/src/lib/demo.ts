/**
 * demo.ts — jeu de données de démonstration (mode invité uniquement).
 *
 * Permet d'explorer Kinetic « rempli » sans rien saisir : 8 semaines de
 * Push/Pull/Legs avec surcharge progressive, pesées, mensurations, XP et série.
 * Déterministe (PRNG à graine fixe) et réversible : chaque clé écrite est listée
 * dans `DEMO_MANIFEST`, `clearDemoData()` retire exactement ces clés.
 */
import { STORAGE_KEYS, type StoragePort, type StorageKey } from '@kinetic/core';
import type { WorkoutSession, SetEntry } from './training/types';
import { DEFAULT_TEMPLATES } from './training/seed';
import { saveSession, sessionStorageKey } from './training/storage';
import { localIsoDate } from './training/next-session';

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

  for (let w = 0; w < WEEKS; w++) {
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
        const load = base + inc * Math.floor(w / 2);
        const sets: SetEntry[] = [];
        for (let i = 0; i < ex.sets; i++) {
          const fatigue = i >= ex.sets - 1 ? 1 : 0;
          const reps = Math.max(3, ex.targetReps - fatigue - (rand() < 0.2 ? 1 : 0));
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

  // Pesées : 3 par semaine, de ~79,4 kg vers ~77,6 kg
  const bodyweight: Array<{ date: string; weight: number; bodyFatPct: number | null; note: null }> =
    [];
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
    });
  }

  const measurements = [WEEKS * 7, 28, 0].map((d, i) => {
    const day = new Date(today);
    day.setDate(today.getDate() - d);
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      id: `demo-m${i}`,
      date: localIsoDate(day),
      chest: r(101 + i * 0.8),
      waist: r(84 - i * 1.2),
      hips: r(97 - i * 0.4),
      leftBicep: r(36 + i * 0.4),
      rightBicep: r(36.3 + i * 0.4),
      shoulders: r(118 + i * 0.7),
      leftThigh: r(58 + i * 0.3),
      rightThigh: r(58.2 + i * 0.3),
    };
  });

  const nowIso = now.toISOString();
  const lastTrained = sessions[sessions.length - 1];
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
    [STORAGE_KEYS.MEASUREMENTS_ENTRIES, measurements],
    [STORAGE_KEYS.XP, { xp: 2350 }],
    [
      STORAGE_KEYS.STREAK,
      {
        count: 4,
        best: 12,
        lastActiveDate: lastTrained ? localIsoDate(new Date(lastTrained.startedAt)) : null,
      },
    ],
  ];

  return { sessions, values };
}

/** Écrit le jeu de démo et mémorise les clés pour pouvoir le retirer. */
export async function loadDemoData(storage: StoragePort, now: Date = new Date()): Promise<number> {
  const { sessions, values } = buildDemoData(now);
  const written: StorageKey[] = [];
  for (const [key, value] of values) {
    await storage.set(key, value);
    written.push(key);
  }
  for (const s of sessions) {
    await saveSession(storage, s);
    written.push(sessionStorageKey(s.id));
  }
  await storage.set(STORAGE_KEYS.DEMO_MANIFEST, written);
  return sessions.length;
}

export async function isDemoActive(storage: StoragePort): Promise<boolean> {
  return Array.isArray(await storage.get(STORAGE_KEYS.DEMO_MANIFEST));
}

/** Retire exactement les clés écrites par la démo. */
export async function clearDemoData(storage: StoragePort): Promise<void> {
  const manifest = await storage.get<StorageKey[]>(STORAGE_KEYS.DEMO_MANIFEST);
  if (!Array.isArray(manifest)) return;
  for (const key of manifest) await storage.remove(key);
  await storage.remove(STORAGE_KEYS.DEMO_MANIFEST);
}
