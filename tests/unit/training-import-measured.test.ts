import { describe, it, expect } from 'vitest';
import {
  importedMeasure,
  measuredSet,
  parseHevyCsv,
  parseStrongCsv,
} from '../../apps/web/src/lib/training/import.js';

describe('measuredSet', () => {
  it('répétitions d’abord', () => {
    expect(measuredSet('8', '60', '', 1000)).toEqual({ reps: 8 });
  });
  it('chronométrée et/ou distance quand reps est vide ou nul', () => {
    expect(measuredSet('', '45', '', 1000)).toEqual({ reps: 0, durationSec: 45 });
    expect(measuredSet('0', '', '0.4', 1000)).toEqual({ reps: 0, distanceM: 400 });
    expect(measuredSet('', '600.4', '2.5', 1000)).toEqual({
      reps: 0,
      durationSec: 600,
      distanceM: 2500,
    });
  });
  it('null si rien d’exploitable', () => {
    expect(measuredSet('', '', '', 1000)).toBeNull();
    expect(measuredSet('0', '0', '0', 1000)).toBeNull();
    expect(measuredSet('abc', 'x', '', 1000)).toBeNull();
  });
});

describe('importedMeasure', () => {
  const base = { setIndex: 0, weightKg: 0, rpe: 7, performedAt: '' };
  it('distance > temps > rien', () => {
    expect(importedMeasure([{ ...base, reps: 0, distanceM: 50, durationSec: 30 }])).toBe(
      'distance',
    );
    expect(importedMeasure([{ ...base, reps: 0, durationSec: 30 }])).toBe('time');
    expect(importedMeasure([{ ...base, reps: 5 }])).toBeUndefined();
    expect(importedMeasure([])).toBeUndefined();
  });
});

describe('Strong : séries chronométrées et de distance', () => {
  const csv = [
    'Date,Workout Name,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,Workout Duration,RPE',
    '"2025-12-01 18:00:00","Core","Plank",1,0,0,0,60,"","",30m,',
    '"2025-12-01 18:00:00","Core","Plank",2,0,0,0,45,"","",30m,',
    '"2025-12-01 18:00:00","Core","Farmer Walk",1,32,0,0.04,,"","",30m,',
    '"2025-12-01 18:00:00","Core","Plank",Rest Timer,0,0,0,90,"","",30m,',
  ].join('\n');

  it('importe durée et distance (km → m), ignore les minuteurs de repos', () => {
    const { bundle, skipped } = parseStrongCsv(csv);
    expect(skipped).toBe(1);
    const s = bundle.sessions[0]!;
    const plank = s.entries.find((e) => e.exerciseId === 'plank')!;
    expect(plank.sets.map((x) => x.durationSec)).toEqual([60, 45]);
    expect(plank.sets.every((x) => x.reps === 0)).toBe(true);
    const walk = s.entries.find((e) => e.exerciseId === 'farmer-walk')!;
    expect(walk.sets[0]).toMatchObject({ reps: 0, distanceM: 40, weightKg: 32 });
    const measures = Object.fromEntries(bundle.createdExercises.map((e) => [e.id, e.measure]));
    expect(measures).toEqual({ plank: 'time', 'farmer-walk': 'distance' });
  });

  it('en-têtes avec unités : livres et miles convertis', () => {
    const withUnits = [
      'Date,Workout Name,Exercise Name,Set Order,Weight (lbs),Reps,Distance (mi),Seconds,RPE',
      '"2025-12-01 18:00:00","Run","Running",1,,,1,480,',
      '"2025-12-01 18:00:00","Run","Curl",1,50,10,,,',
    ].join('\n');
    const { bundle } = parseStrongCsv(withUnits);
    const s = bundle.sessions[0]!;
    expect(s.entries.find((e) => e.exerciseId === 'running')!.sets[0]).toMatchObject({
      distanceM: 1609,
      durationSec: 480,
    });
    expect(s.entries.find((e) => e.exerciseId === 'curl')!.sets[0]!.weightKg).toBeCloseTo(22.68);
  });
});

describe('Hevy : duration_seconds / distance_km', () => {
  const csv = [
    'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
    '"Cardio","2025-12-03 07:00:00","2025-12-03 07:40:00","","Rowing Machine",,"",0,normal,,,2,480,',
    '"Cardio","2025-12-03 07:00:00","2025-12-03 07:40:00","","Plank",,"",0,normal,,,,90,',
    '"Cardio","2025-12-03 07:00:00","2025-12-03 07:40:00","","Plank",,"",1,warmup,,,,30,',
  ].join('\n');

  it('importe les séries mesurées avec leur type', () => {
    const { bundle, skipped } = parseHevyCsv(csv);
    expect(skipped).toBe(0);
    const s = bundle.sessions[0]!;
    expect(s.entries.find((e) => e.exerciseId === 'rowing-machine')!.sets[0]).toMatchObject({
      reps: 0,
      distanceM: 2000,
      durationSec: 480,
    });
    const plank = s.entries.find((e) => e.exerciseId === 'plank')!;
    expect(plank.sets.find((x) => x.kind === 'warmup')?.durationSec).toBe(30);
    expect(bundle.createdExercises.find((e) => e.id === 'plank')?.measure).toBe('time');
  });
});
