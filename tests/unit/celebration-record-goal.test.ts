/**
 * Une même série qui bat un record ET remplit un objectif : une seule carte de
 * célébration (« Nouveau record et objectif atteint ! »), pas deux à la suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  goalCelebration,
  mergeRecordAndGoals,
  recordCelebration,
} from '../../apps/web/src/lib/celebration.js';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({ storage: { set: vi.fn(async () => undefined) } })),
}));
vi.mock('../../apps/web/src/pages/template-editor.page.js', () => ({
  openTemplateEditor: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/rest-alert.js', () => ({
  scheduleRestAlert: vi.fn(async () => {}),
  cancelRestAlert: vi.fn(async () => {}),
}));

const { seances } = await import('../../apps/web/src/pages/seances.page.js');
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

describe('mergeRecordAndGoals', () => {
  const record = recordCelebration('Squat', 120, 5);
  const goal = goalCelebration('Squat : 120 kg × 5');

  it('record + objectif : une seule carte', () => {
    const out = mergeRecordAndGoals(record, [goal]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Nouveau record et objectif atteint !');
    expect(out[0]!.subtitle).toBe(record.subtitle);
    expect(out[0]!.kind).toBe('record');
  });

  it('record seul, objectif seul, rien', () => {
    expect(mergeRecordAndGoals(record, [])).toEqual([record]);
    expect(mergeRecordAndGoals(null, [goal])).toEqual([goal]);
    expect(mergeRecordAndGoals(null, [])).toEqual([]);
  });

  it('record + deux objectifs remplis par la même série : toujours une carte', () => {
    expect(mergeRecordAndGoals(record, [goal, goal])).toHaveLength(1);
  });
});

describe('séance : série record qui remplit un objectif', () => {
  const dispatched: Event[] = [];
  beforeEach(() => {
    dispatched.length = 0;
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => dispatched.push(e) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('une seule célébration', () => {
    const page = seances();
    page.exercises = [{ id: 'squat', name: 'Squat', muscles: ['quads'], incrementKg: 2.5 }];
    page.sessions = [
      {
        id: 'old',
        name: 'Jambes',
        startedAt: '2026-11-10T10:00:00Z',
        endedAt: '2026-11-10T11:00:00Z',
        entries: [
          {
            exerciseId: 'squat',
            sets: [{ setIndex: 0, weightKg: 110, reps: 5, performedAt: '2026-11-10T10:00:00Z' }],
          },
        ],
      } as WorkoutSession,
    ];
    page.currentSession = {
      id: 'now',
      name: 'Jambes',
      startedAt: new Date().toISOString(),
      entries: [{ exerciseId: 'squat', sets: [] }],
    };
    page._strengthGoals = [
      { id: 'g1', exerciseId: 'squat', kind: 'weight', targetKg: 120, createdAt: '2026-10-01' },
    ];
    page.draft.weightKg = 120;
    page.draft.reps = 5;
    page.draft.rpe = 9;
    page.addSet('squat');
    const cards = dispatched.filter((e) => e.type === STORAGE_KEYS.EVENT_CELEBRATE);
    expect(cards).toHaveLength(1);
    expect((cards[0] as CustomEvent<{ title: string }>).detail.title).toBe(
      'Nouveau record et objectif atteint !',
    );
    expect(page._strengthGoals[0]!.achievedAt).toBeTruthy();
  });
});
