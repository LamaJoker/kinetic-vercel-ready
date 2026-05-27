import { describe, it, expect } from 'vitest';
import {
  PROGRAMS_CATALOG,
  findProgram,
  resolveProgramSession,
} from '../../packages/core/src/domain/programs-catalog.domain.js';

describe('PROGRAMS_CATALOG', () => {
  it('contient les 5 programmes attendus', () => {
    const ids = PROGRAMS_CATALOG.map((p) => p.id);
    expect(ids).toContain('531-bbb');
    expect(ids).toContain('starting-strength');
    expect(ids).toContain('gzclp');
    expect(ids).toContain('madcow-5x5');
    expect(ids).toContain('nsuns-531-lp');
  });

  it('chaque programme a au moins une semaine et une séance, et un trainingMaxFactor cohérent', () => {
    for (const p of PROGRAMS_CATALOG) {
      expect(p.weeks.length).toBeGreaterThan(0);
      expect(p.weeks[0]!.sessions.length).toBeGreaterThan(0);
      expect(p.trainingMaxFactor).toBeGreaterThan(0);
      expect(p.trainingMaxFactor).toBeLessThanOrEqual(1);
    }
  });

  it('5/3/1 deload semaine 4 est strictement plus léger que semaine 3', () => {
    const program = findProgram('531-bbb')!;
    const week3 = program.weeks[2]!;
    const week4 = program.weeks[3]!;
    const max3 = Math.max(
      ...week3.sessions.flatMap((s) =>
        s.exercises.flatMap((e) => e.sets.map((set) => set.intensity)),
      ),
    );
    const max4 = Math.max(
      ...week4.sessions.flatMap((s) =>
        s.exercises.flatMap((e) => e.sets.map((set) => set.intensity)),
      ),
    );
    expect(max4).toBeLessThan(max3);
  });
});

describe('findProgram', () => {
  it('retourne null pour un id inconnu', () => {
    expect(findProgram('xxx')).toBeNull();
  });

  it("retourne l'entrée pour un id valide", () => {
    expect(findProgram('531-bbb')?.id).toBe('531-bbb');
  });
});

describe('resolveProgramSession', () => {
  it("calcule des charges multiples de l'incrément à partir du 1RM", () => {
    const program = findProgram('531-bbb')!;
    const session = program.weeks[0]!.sessions[0]!; // press day
    const resolved = resolveProgramSession(
      session,
      { overhead_press: 60 },
      program.trainingMaxFactor,
      2.5,
    );
    expect(resolved.exercises.length).toBeGreaterThan(0);
    for (const ex of resolved.exercises) {
      for (const set of ex.sets) {
        expect(set.weightKg % 2.5).toBe(0);
      }
    }
  });

  it('met 0 kg si le 1RM manque pour la lift référencée', () => {
    const program = findProgram('531-bbb')!;
    const session = program.weeks[0]!.sessions[1]!; // deadlift day
    const resolved = resolveProgramSession(session, {}, 0.9, 2.5);
    expect(resolved.exercises[0]!.sets[0]!.weightKg).toBe(0);
  });

  it('garde le flag amrap sur le dernier set principal', () => {
    const program = findProgram('531-bbb')!;
    const session = program.weeks[0]!.sessions[0]!;
    const resolved = resolveProgramSession(session, { overhead_press: 80 }, 0.9, 2.5);
    const lastSet = resolved.exercises[0]!.sets.at(-1)!;
    expect(lastSet.amrap).toBe(true);
  });
});
