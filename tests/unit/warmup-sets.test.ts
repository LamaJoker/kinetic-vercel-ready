/**
 * Séries d'échauffement : rétro-compatibles (sans `kind` = travail) et exclues
 * des agrégats (résumé de séance), conservées à l'export et lues à l'import.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSession } from '../../apps/web/src/lib/training/next-session.js';
import { buildCsvExport, buildJsonExport } from '../../apps/web/src/lib/training/export.js';
import {
  parseHevyCsv,
  parseKineticJson,
  parseStrongCsv,
} from '../../apps/web/src/lib/training/import.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const AT = '2026-11-10T10:00:00.000Z';
const SESSION: WorkoutSession = {
  id: 's1',
  name: 'Jambes',
  startedAt: AT,
  endedAt: '2026-11-10T11:00:00.000Z',
  entries: [
    {
      exerciseId: 'squat',
      sets: [
        { setIndex: 0, reps: 10, weightKg: 20, rpe: 6, performedAt: AT, kind: 'warmup' },
        { setIndex: 1, reps: 5, weightKg: 100, rpe: 8, performedAt: AT },
      ],
    },
  ],
};

describe('échauffements', () => {
  it('exclus du résumé de séance (séries, volume)', () => {
    expect(summarizeSession(SESSION)).toMatchObject({ setCount: 1, volumeKg: 500 });
  });

  it('export CSV : colonne set_type ; JSON : kind conservé à l’aller-retour', () => {
    const lines = buildCsvExport([SESSION], []).trim().split('\r\n');
    expect(lines[0]!.endsWith('"set_type"')).toBe(true);
    expect(lines[1]!.endsWith(',warmup')).toBe(true);
    expect(lines[2]!.endsWith(',work')).toBe(true);
    const back = parseKineticJson(buildJsonExport([SESSION], []));
    expect(back.sessions[0]!.entries[0]!.sets[0]!.kind).toBe('warmup');
    expect(back.sessions[0]!.entries[0]!.sets[1]!.kind).toBeUndefined();
  });

  it('import Strong (« W ») et Hevy (set_type warmup)', () => {
    const strong = parseStrongCsv(
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,RPE\n' +
        '"2025-12-01 18:32:48","Push","Bench",W,40,10,\n' +
        '"2025-12-01 18:32:48","Push","Bench",1,100,5,8\n',
    );
    const strongSets = strong.bundle.sessions[0]!.entries[0]!.sets;
    expect(strongSets.map((s) => s.kind)).toEqual(['warmup', undefined]);

    const hevy = parseHevyCsv(
      'title,start_time,exercise_title,set_index,set_type,weight_kg,reps,rpe\n' +
        '"Push","2025-12-01 18:32:48","Bench",0,warmup,40,10,\n' +
        '"Push","2025-12-01 18:32:48","Bench",1,normal,100,5,8\n',
    );
    const hevySets = hevy.bundle.sessions[0]!.entries[0]!.sets;
    expect(hevySets.map((s) => s.kind)).toEqual(['warmup', undefined]);
  });

  it('import Strong : plusieurs « W », échauffements d’abord et setIndex uniques', () => {
    const strong = parseStrongCsv(
      'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,RPE\n' +
        '"2025-12-01 18:32:48","Push","Bench",W,20,10,\n' +
        '"2025-12-01 18:32:48","Push","Bench",W,60,5,\n' +
        '"2025-12-01 18:32:48","Push","Bench",1,100,5,8\n' +
        '"2025-12-01 18:32:48","Push","Bench",2,100,4,9\n',
    );
    const sets = strong.bundle.sessions[0]!.entries[0]!.sets;
    expect(sets.map((s) => `${s.kind ?? 'work'}:${s.weightKg}x${s.reps}`)).toEqual([
      'warmup:20x10',
      'warmup:60x5',
      'work:100x5',
      'work:100x4',
    ]);
    expect(sets.map((s) => s.setIndex)).toEqual([0, 1, 2, 3]);
  });
});
