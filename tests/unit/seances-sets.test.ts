import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolé du routeur (Alpine a besoin du DOM) : seule la page Séances est testée.
vi.mock('../../apps/web/src/pages/template-editor.page.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));

import { scheduleRestAlert, cancelRestAlert } from '../../apps/web/src/lib/training/rest-alert.js';
import { seances, entriesTonnageKg } from '../../apps/web/src/pages/seances.page.js';
import type { Exercise, WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const BENCH: Exercise = {
  id: 'bench',
  name: 'Développé couché',
  muscles: ['chest'],
  equipment: 'barbell',
  incrementKg: 2.5,
};

function set(weightKg: number, reps: number, rpe = 8, kind?: 'warmup') {
  return {
    setIndex: 0,
    weightKg,
    reps,
    rpe,
    performedAt: '2026-11-10T10:00:00Z',
    ...(kind ? { kind } : {}),
  };
}

function pageWith(lastSets: ReturnType<typeof set>[]) {
  const page = seances();
  page.exercises = [BENCH];
  page.sessions = [
    {
      id: 'old',
      name: 'Haut',
      startedAt: '2026-11-10T10:00:00Z',
      endedAt: '2026-11-10T11:00:00Z',
      entries: [{ exerciseId: 'bench', sets: lastSets }],
    } as WorkoutSession,
  ];
  page.currentSession = {
    id: 'now',
    name: 'Haut',
    startedAt: new Date().toISOString(),
    entries: [{ exerciseId: 'bench', sets: [] }],
  };
  return page;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('séance : la dernière fois', () => {
  it('affiche les séries de travail de la dernière séance', () => {
    const page = pageWith([set(20, 10, 6, 'warmup'), set(40, 8), set(42.5, 8), set(42.5, 7)]);
    expect(page.lastTimeLabel('bench')).toBe('Dernière fois · 40×8 · 42,5×8 · 42,5×7');
  });

  it('pré-remplit chaque nouvelle série avec la série correspondante (coach plus léger)', () => {
    const page = pageWith([set(40, 8), set(42.5, 8), set(42.5, 7)]);
    page.coachGoal = 'endurance'; // cible du coach : ~35 kg × 15, pas une progression
    page._syncDraft();
    expect([page.draft.weightKg, page.draft.reps]).toEqual([40, 8]);
    page.addSet('bench');
    page._syncDraft();
    expect([page.draft.weightKg, page.draft.reps]).toEqual([42.5, 8]);
  });

  it('« Même chose » valide la série correspondante en un geste', () => {
    const page = pageWith([set(40, 8), set(42.5, 8)]);
    const entry = page.currentEntries[0]!;
    expect(page.sameAsLastLabel(entry)).toBe('40×8');
    page.repeatLast(entry);
    expect(page.currentEntries[0]!.sets.map((s) => [s.weightKg, s.reps])).toEqual([[40, 8]]);
  });

  it('la cible du coach passe devant quand elle propose de monter', () => {
    // 60×12 à RPE 6 : trop facile pour l'hypertrophie → le coach propose plus lourd
    const page = pageWith([set(60, 12, 6), set(60, 12, 6)]);
    page.coachGoal = 'hypertrophie';
    const advice = page.coachAdvice('bench')!;
    expect(advice.weightKg).toBeGreaterThan(60);
    page._syncDraft();
    expect([page.draft.weightKg, page.draft.reps]).toEqual([advice.weightKg, advice.reps]);
    expect(page.sameAsLastLabel(page.currentEntries[0]!)).toBe('60×12');
  });
});

describe('séance : échauffement', () => {
  it('génère la montée, à part, hors tonnage et sans repos automatique', () => {
    const page = pageWith([set(100, 5)]);
    page.draft.weightKg = 100;
    page.addWarmups('bench');
    const entry = page.currentEntries[0]!;
    expect(page.warmupSets(entry).map((s) => [s.weightKg, s.reps])).toEqual([
      [20, 10],
      [40, 8],
      [60, 5],
      [80, 3],
    ]);
    expect(page.workSetCount(entry)).toBe(0);
    expect(entriesTonnageKg(page.currentEntries)).toBe(0);
    expect(page.sessionSetCount()).toBe(0);
    expect(page.draftTitle(entry)).toBe('Série 1');

    page.toggleDraftWarmup();
    page.draft.weightKg = 90;
    page.draft.reps = 1;
    page.addSet('bench');
    expect(page.restEndsAtMs).toBe(0);
    expect(page.warmupSets(page.currentEntries[0]!)).toHaveLength(5);
    expect(page.pr('bench')).toBeCloseTo(116.7, 1); // l'échauffement à 90 kg ne compte pas
  });

  it('modifier / retirer un échauffement passe par la séance (enregistrée)', () => {
    const page = pageWith([]);
    page.draft.weightKg = 100;
    page.addWarmups('bench');
    const second = page.warmupSets(page.currentEntries[0]!)[1]!;
    page.editWarmup('bench', second.setIndex, 'weightKg', '45');
    expect(page.warmupSets(page.currentEntries[0]!)[1]!.weightKg).toBe(45);
    page.removeWarmup('bench', second.setIndex);
    expect(page.warmupSets(page.currentEntries[0]!)).toHaveLength(3);
    page.toggleDraftWarmup(); // retour en travail
    page.toggleDraftWarmup();
    page.draftWarmup = false;
    page.draft.weightKg = 100;
    page.draft.reps = 5;
    page.addSet('bench');
    const sets = page.currentEntries[0]!.sets;
    expect(sets.map((s) => s.setIndex)).toEqual([0, 1, 2, 3]);
    expect(page.setTag(page.currentEntries[0]!, sets[3]!)).toBe('#1');
    expect(page.setTag(page.currentEntries[0]!, sets[0]!)).toBe('É');
  });
});

describe('séance : alerte de fin de repos', () => {
  it('programmée au démarrage du repos, annulée quand il est passé', () => {
    const page = pageWith([]);
    page.nowMs = Date.now();
    page.startRest();
    expect(scheduleRestAlert).toHaveBeenCalledWith(expect.any(Number), 'Développé couché');
    page.skipRest();
    expect(cancelRestAlert).toHaveBeenCalled();
  });

  it('retour au premier plan : repos fini pendant l’absence → terminé', () => {
    const page = pageWith([]);
    page.nowMs = Date.now();
    page.startRest();
    vi.setSystemTime(Date.now() + 10 * 60_000); // minuteur figé en arrière-plan
    page._resyncRest();
    expect(page.restEndsAtMs).toBe(0);
    expect(page.fullscreenRest).toBe(false);
  });

  it('retour au premier plan : temps restant recalculé sans reprogrammer l’alerte', () => {
    const page = pageWith([]);
    page.nowMs = Date.now();
    page.restPresetSec = 120;
    page.startRest();
    vi.mocked(scheduleRestAlert).mockClear();
    vi.setSystemTime(Date.now() + 30_000);
    page._resyncRest();
    expect(page.restRemainingSec()).toBe(90);
    expect(scheduleRestAlert).not.toHaveBeenCalled();
  });
});

describe('séance : gestionnaires à une seule expression (build CSP)', () => {
  it('« Appliquer » remplit la saisie avec la cible du coach', () => {
    const page = pageWith([set(40, 8), set(42.5, 8)]);
    const advice = page.coachAdvice('bench')!;
    page.draft.weightKg = 0;
    page.draft.reps = 0;
    page.applyCoach('bench');
    expect([page.draft.weightKg, page.draft.reps, page.draft.rpe]).toEqual([
      advice.weightKg,
      advice.reps,
      advice.rpe,
    ]);
  });

  it('choisir une durée de repos la retient et ferme la liste', () => {
    const page = pageWith([]);
    page.showRestPresets = true;
    page.pickRestPreset(120);
    expect(page.restPresetSec).toBe(120);
    expect(page.showRestPresets).toBe(false);
  });
});

describe('séance : échauffement au poids du corps', () => {
  it("pas de bouton « Ajouter l'échauffement » pour un exercice au poids du corps", () => {
    const page = pageWith([]);
    const entry = page.currentEntries[0]!;
    expect(page.canAddWarmup(entry)).toBe(true);
    page.exercises = [{ ...BENCH, equipment: 'bodyweight' }];
    expect(page.canAddWarmup(entry)).toBe(false);
  });
});
