/**
 * Programs Catalog — programmes pré-écrits basés sur des protocoles éprouvés.
 *
 * Chaque programme est décrit comme une suite de séances qui prennent un 1RM
 * de référence pour les big lifts et calculent les charges en % 1RM.
 *
 * Sources :
 *   - Jim Wendler — 5/3/1 (2009 + Beyond 5/3/1, 2013)
 *   - Mark Rippetoe — Starting Strength (3rd ed, 2011)
 *   - Cody Lefever — GZCLP (Reddit /r/weightroom, 2013)
 *   - Sheiko Powerlifting (Boris Sheiko, classique russe)
 *   - Bill Starr — Madcow 5x5
 *
 * Pur — aucune dépendance, aucun I/O.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type LiftKey = 'squat' | 'bench' | 'deadlift' | 'overhead_press' | 'row';

export interface ProgramSetSpec {
  /** Fraction du 1RM de la lift de référence (0.55–1.05). */
  intensity: number;
  reps: number;
  /** Vrai si l'utilisateur doit pousser jusqu'à l'échec ou +AMRAP (As Many Reps As Possible). */
  amrap?: boolean;
  /** Notes pédagogiques courtes pour l'UI. */
  note?: string;
}

export interface ProgramExerciseSpec {
  /** Big lift référence : on calcule la charge à partir du 1RM de cette lift. */
  liftRef: LiftKey;
  /** Sets prescrits dans l'ordre. */
  sets: ProgramSetSpec[];
}

export interface ProgramSessionSpec {
  name: string;
  exercises: ProgramExerciseSpec[];
}

export interface ProgramWeekSpec {
  /** Numéro de semaine (1-indexé). */
  index: number;
  label: string;
  sessions: ProgramSessionSpec[];
  /** Note pour l'utilisateur (ex: "Semaine de deload, RPE 6"). */
  note?: string;
}

export interface ProgramCatalogEntry {
  id: string;
  name: string;
  durationWeeks: number;
  daysPerWeek: number;
  goal: 'strength' | 'hypertrophy' | 'powerlifting' | 'general';
  level: 'beginner' | 'intermediate' | 'advanced';
  /**
   * Coefficient training-max : 5/3/1 utilise 0.9 × 1RM "vrai" comme base.
   * SS / GZCLP utilisent le 1RM direct (1.0).
   */
  trainingMaxFactor: number;
  description: string;
  weeks: ProgramWeekSpec[];
  citation: string;
}

export interface OneRepMaxes {
  squat?: number;
  bench?: number;
  deadlift?: number;
  overhead_press?: number;
  row?: number;
}

// ─── Programmes ─────────────────────────────────────────────────────────────

/**
 * 5/3/1 BBB (Boring But Big) — Jim Wendler, 4 semaines.
 *
 * Cycle : 65/75/85 → 70/80/90 → 75/85/95 → deload.
 * BBB : 5x10 @ 50% TM en accessoire après les sets principaux.
 */
const FIVE_THREE_ONE: ProgramCatalogEntry = {
  id: '531-bbb',
  name: '5/3/1 BBB',
  durationWeeks: 4,
  daysPerWeek: 4,
  goal: 'strength',
  level: 'intermediate',
  trainingMaxFactor: 0.9,
  description:
    "4 jours/semaine, basé sur un 'training max' (TM = 0.9 × 1RM vrai). Dernier set en AMRAP — pousse pour battre les reps. BBB ajoute 5x10 léger en hypertrophie après.",
  citation: 'Jim Wendler — 5/3/1 for Powerlifting (2009)',
  weeks: [
    {
      index: 1,
      label: 'Semaine 1 — 5/5/5+',
      sessions: [
        oneLiftDay('Press Day', 'overhead_press', [
          { intensity: 0.65, reps: 5 },
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 5, amrap: true, note: 'Pousse au max — minimum 5' },
        ]),
        oneLiftDay('Deadlift Day', 'deadlift', [
          { intensity: 0.65, reps: 5 },
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 5, amrap: true },
        ]),
        oneLiftDay('Bench Day', 'bench', [
          { intensity: 0.65, reps: 5 },
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 5, amrap: true },
        ]),
        oneLiftDay('Squat Day', 'squat', [
          { intensity: 0.65, reps: 5 },
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 5, amrap: true },
        ]),
      ],
    },
    {
      index: 2,
      label: 'Semaine 2 — 3/3/3+',
      sessions: [
        oneLiftDay('Press Day', 'overhead_press', [
          { intensity: 0.7, reps: 3 },
          { intensity: 0.8, reps: 3 },
          { intensity: 0.9, reps: 3, amrap: true },
        ]),
        oneLiftDay('Deadlift Day', 'deadlift', [
          { intensity: 0.7, reps: 3 },
          { intensity: 0.8, reps: 3 },
          { intensity: 0.9, reps: 3, amrap: true },
        ]),
        oneLiftDay('Bench Day', 'bench', [
          { intensity: 0.7, reps: 3 },
          { intensity: 0.8, reps: 3 },
          { intensity: 0.9, reps: 3, amrap: true },
        ]),
        oneLiftDay('Squat Day', 'squat', [
          { intensity: 0.7, reps: 3 },
          { intensity: 0.8, reps: 3 },
          { intensity: 0.9, reps: 3, amrap: true },
        ]),
      ],
    },
    {
      index: 3,
      label: 'Semaine 3 — 5/3/1+',
      sessions: [
        oneLiftDay('Press Day', 'overhead_press', [
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 3 },
          { intensity: 0.95, reps: 1, amrap: true, note: 'Top set : pousse pour 3+ reps' },
        ]),
        oneLiftDay('Deadlift Day', 'deadlift', [
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 3 },
          { intensity: 0.95, reps: 1, amrap: true },
        ]),
        oneLiftDay('Bench Day', 'bench', [
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 3 },
          { intensity: 0.95, reps: 1, amrap: true },
        ]),
        oneLiftDay('Squat Day', 'squat', [
          { intensity: 0.75, reps: 5 },
          { intensity: 0.85, reps: 3 },
          { intensity: 0.95, reps: 1, amrap: true },
        ]),
      ],
    },
    {
      index: 4,
      label: 'Semaine 4 — Deload',
      note: 'Repos actif : technique uniquement, jamais à l’échec.',
      sessions: [
        oneLiftDay('Press Day', 'overhead_press', [
          { intensity: 0.4, reps: 5 },
          { intensity: 0.5, reps: 5 },
          { intensity: 0.6, reps: 5 },
        ]),
        oneLiftDay('Deadlift Day', 'deadlift', [
          { intensity: 0.4, reps: 5 },
          { intensity: 0.5, reps: 5 },
          { intensity: 0.6, reps: 5 },
        ]),
        oneLiftDay('Bench Day', 'bench', [
          { intensity: 0.4, reps: 5 },
          { intensity: 0.5, reps: 5 },
          { intensity: 0.6, reps: 5 },
        ]),
        oneLiftDay('Squat Day', 'squat', [
          { intensity: 0.4, reps: 5 },
          { intensity: 0.5, reps: 5 },
          { intensity: 0.6, reps: 5 },
        ]),
      ],
    },
  ],
};

/**
 * Starting Strength — 3 jours/semaine, full body alternant A/B.
 * Linear progression : +2.5 kg upper / +5 kg lower par séance.
 */
const STARTING_STRENGTH: ProgramCatalogEntry = {
  id: 'starting-strength',
  name: 'Starting Strength',
  durationWeeks: 12,
  daysPerWeek: 3,
  goal: 'strength',
  level: 'beginner',
  trainingMaxFactor: 1.0,
  description:
    '3 jours/sem, full body, progression linéaire. Idéal débutant : +2.5 kg upper / +5 kg lower à chaque séance tant que possible. Dans Kinetic, les charges suggérées sont fixées à 80 % du 1RM courant (zone 5 reps).',
  citation: 'Mark Rippetoe — Starting Strength (3rd ed, 2011)',
  weeks: makeStartingStrengthWeeks(),
};

function makeStartingStrengthWeeks(): ProgramWeekSpec[] {
  // Sur 12 semaines on alterne A (Squat / Bench / Deadlift) et B (Squat / OHP / Power Clean ≈ Row).
  // L'utilisateur ajustera ses charges manuellement (progression linéaire chaque séance).
  const sessionA = (label: string): ProgramSessionSpec => ({
    name: `${label} — A`,
    exercises: [
      oneLift('squat', threeByFive()),
      oneLift('bench', threeByFive()),
      oneLift('deadlift', [{ intensity: 0.82, reps: 5, note: '1×5 lourd' }]),
    ],
  });
  const sessionB = (label: string): ProgramSessionSpec => ({
    name: `${label} — B`,
    exercises: [
      oneLift('squat', threeByFive()),
      oneLift('overhead_press', threeByFive()),
      oneLift('row', threeByFive()),
    ],
  });
  return Array.from({ length: 12 }, (_, i) => {
    const idx = i + 1;
    return {
      index: idx,
      label: `Semaine ${idx}`,
      sessions: [
        idx % 2 === 1 ? sessionA('Lundi') : sessionB('Lundi'),
        idx % 2 === 1 ? sessionB('Mercredi') : sessionA('Mercredi'),
        idx % 2 === 1 ? sessionA('Vendredi') : sessionB('Vendredi'),
      ],
    };
  });
}

function threeByFive(): ProgramSetSpec[] {
  return [
    { intensity: 0.8, reps: 5 },
    { intensity: 0.8, reps: 5 },
    { intensity: 0.8, reps: 5, note: 'Si 3×5 propre : +2.5 kg upper / +5 kg lower demain' },
  ];
}

/**
 * GZCLP — Cody Lefever, linéaire pour intermédiaire.
 * Tier 1 : 5x3 (T1), Tier 2 : 3x10 (T2), Tier 3 : 3x15 (T3).
 */
const GZCLP: ProgramCatalogEntry = {
  id: 'gzclp',
  name: 'GZCLP',
  durationWeeks: 12,
  daysPerWeek: 4,
  goal: 'strength',
  level: 'intermediate',
  trainingMaxFactor: 0.85,
  description:
    'Hybride force/hypertrophie. T1 (gros lifts, 5×3 lourd), T2 (3×10 modéré), T3 (3×15 léger). Progression : +5 kg lower / +2.5 kg upper si tous les sets passent ; descente progressive sinon.',
  citation: 'Cody Lefever — GZCLP (/r/weightroom, 2013)',
  weeks: makeGzclpWeeks(),
};

function makeGzclpWeeks(): ProgramWeekSpec[] {
  // 4 séances/semaine, rotation A1/B1/A2/B2 sur 4 jours
  const day = (label: string, t1: LiftKey, t2: LiftKey): ProgramSessionSpec => ({
    name: label,
    exercises: [
      oneLift(t1, [
        { intensity: 0.85, reps: 3, note: 'T1 : 5×3 puis 1×3+ AMRAP au dernier' },
        { intensity: 0.85, reps: 3 },
        { intensity: 0.85, reps: 3 },
        { intensity: 0.85, reps: 3 },
        { intensity: 0.85, reps: 3, amrap: true },
      ]),
      oneLift(t2, [
        { intensity: 0.65, reps: 10, note: 'T2 : 3×10 modéré' },
        { intensity: 0.65, reps: 10 },
        { intensity: 0.65, reps: 10 },
      ]),
    ],
  });
  return Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    label: `Semaine ${i + 1}`,
    sessions: [
      day('Lundi — Squat T1 / Bench T2', 'squat', 'bench'),
      day('Mardi — OHP T1 / Deadlift T2', 'overhead_press', 'deadlift'),
      day('Jeudi — Bench T1 / Squat T2', 'bench', 'squat'),
      day('Vendredi — Deadlift T1 / OHP T2', 'deadlift', 'overhead_press'),
    ],
  }));
}

/**
 * Madcow 5x5 — Bill Starr (variante intermédiaire).
 */
const MADCOW: ProgramCatalogEntry = {
  id: 'madcow-5x5',
  name: 'Madcow 5x5',
  durationWeeks: 12,
  daysPerWeek: 3,
  goal: 'strength',
  level: 'intermediate',
  trainingMaxFactor: 1.0,
  description:
    'Variante intermédiaire de la méthode Bill Starr : 3 séances/sem, ramp-up à 5×5 lourd lundi, light mercredi, médium vendredi avec PR optionnel. Progression : +2.5 kg/sem.',
  citation: 'Bill Starr — Strongest Shall Survive (1976) / Glenn Pendlay (madcow.com)',
  weeks: makeMadcowWeeks(),
};

function makeMadcowWeeks(): ProgramWeekSpec[] {
  const heavy = (lift: LiftKey): ProgramExerciseSpec =>
    oneLift(lift, [
      { intensity: 0.5, reps: 5, note: 'Ramp-up' },
      { intensity: 0.625, reps: 5 },
      { intensity: 0.75, reps: 5 },
      { intensity: 0.875, reps: 5 },
      { intensity: 1.0, reps: 5, amrap: true, note: 'Top set 5RM' },
    ]);
  const light = (lift: LiftKey): ProgramExerciseSpec =>
    oneLift(lift, [
      { intensity: 0.5, reps: 5 },
      { intensity: 0.625, reps: 5 },
      { intensity: 0.75, reps: 5 },
      { intensity: 0.75, reps: 5 },
      { intensity: 0.75, reps: 5 },
    ]);

  return Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    label: `Semaine ${i + 1}`,
    sessions: [
      { name: 'Lundi — Lourd', exercises: [heavy('squat'), heavy('bench'), heavy('row')] },
      {
        name: 'Mercredi — Léger',
        exercises: [
          light('squat'),
          light('overhead_press'),
          oneLift('deadlift', [
            { intensity: 0.5, reps: 5 },
            { intensity: 0.625, reps: 5 },
            { intensity: 0.75, reps: 5, note: '1×5 deadlift seulement, technique' },
          ]),
        ],
      },
      {
        name: 'Vendredi — PR',
        exercises: [
          heavy('squat'),
          heavy('bench'),
          oneLift('deadlift', [
            { intensity: 0.5, reps: 5 },
            { intensity: 0.625, reps: 5 },
            { intensity: 0.75, reps: 5 },
            { intensity: 0.875, reps: 5 },
            { intensity: 1.0, reps: 5, amrap: true, note: 'Top set deadlift PR' },
          ]),
        ],
      },
    ],
  }));
}

/**
 * nSuns 5/3/1 LP — variante moderne avec volume plus élevé.
 */
const NSUNS: ProgramCatalogEntry = {
  id: 'nsuns-531-lp',
  name: 'nSuns 5/3/1 LP',
  durationWeeks: 8,
  daysPerWeek: 4,
  goal: 'powerlifting',
  level: 'intermediate',
  trainingMaxFactor: 0.9,
  description:
    'Adaptation Reddit du 5/3/1 avec plus de volume : 9 sets sur le main lift. Top set AMRAP. Progression : +2.5 kg upper / +5 kg lower par semaine si AMRAP ≥ reps cible.',
  citation: 'reddit.com/r/nSuns — adapté de Wendler 5/3/1',
  weeks: makeNsunsWeeks(),
};

function makeNsunsWeeks(): ProgramWeekSpec[] {
  const nsunsDay = (label: string, lift: LiftKey): ProgramSessionSpec => ({
    name: label,
    exercises: [
      oneLift(lift, [
        { intensity: 0.65, reps: 8 },
        { intensity: 0.75, reps: 6 },
        { intensity: 0.85, reps: 4, amrap: true, note: 'Top set AMRAP' },
        { intensity: 0.85, reps: 4 },
        { intensity: 0.8, reps: 4 },
        { intensity: 0.75, reps: 5 },
        { intensity: 0.7, reps: 6 },
        { intensity: 0.65, reps: 7 },
        { intensity: 0.6, reps: 8 },
      ]),
    ],
  });
  return Array.from({ length: 8 }, (_, i) => ({
    index: i + 1,
    label: `Semaine ${i + 1}`,
    sessions: [
      nsunsDay('Lundi — Bench', 'bench'),
      nsunsDay('Mardi — Squat', 'squat'),
      nsunsDay('Jeudi — OHP', 'overhead_press'),
      nsunsDay('Vendredi — Deadlift', 'deadlift'),
    ],
  }));
}

// ─── Catalogue exposé ────────────────────────────────────────────────────────

export const PROGRAMS_CATALOG: readonly ProgramCatalogEntry[] = [
  FIVE_THREE_ONE,
  STARTING_STRENGTH,
  GZCLP,
  MADCOW,
  NSUNS,
];

export function findProgram(id: string): ProgramCatalogEntry | null {
  return PROGRAMS_CATALOG.find((p) => p.id === id) ?? null;
}

// ─── Calcul des charges à partir des 1RM ────────────────────────────────────

export interface ResolvedSet {
  weightKg: number;
  reps: number;
  amrap: boolean;
  note?: string;
}

export interface ResolvedExercise {
  liftRef: LiftKey;
  sets: ResolvedSet[];
}

export interface ResolvedSession {
  name: string;
  exercises: ResolvedExercise[];
}

/**
 * resolveProgramSession — calcule les charges absolues d'une séance pour
 * un set de 1RM donnés et un pas d'arrondi (2.5 kg par défaut).
 *
 * Si un 1RM manque pour une lift référencée, la séance contient toujours
 * la lift mais avec weightKg = 0 — l'UI doit afficher un avertissement.
 */
export function resolveProgramSession(
  session: ProgramSessionSpec,
  oneRms: OneRepMaxes,
  trainingMaxFactor: number,
  incrementKg = 2.5,
): ResolvedSession {
  const step = incrementKg > 0 ? incrementKg : 2.5;
  return {
    name: session.name,
    exercises: session.exercises.map((ex) => {
      const raw1Rm = oneRms[ex.liftRef] ?? 0;
      const tm = raw1Rm * trainingMaxFactor;
      return {
        liftRef: ex.liftRef,
        sets: ex.sets.map((set) => ({
          weightKg: Math.max(0, Math.round((tm * set.intensity) / step) * step),
          reps: set.reps,
          amrap: !!set.amrap,
          ...(set.note ? { note: set.note } : {}),
        })),
      };
    }),
  };
}

// ─── Helpers internes ────────────────────────────────────────────────────────

function oneLift(liftRef: LiftKey, sets: ProgramSetSpec[]): ProgramExerciseSpec {
  return { liftRef, sets };
}

function oneLiftDay(name: string, liftRef: LiftKey, sets: ProgramSetSpec[]): ProgramSessionSpec {
  return { name, exercises: [{ liftRef, sets }] };
}
