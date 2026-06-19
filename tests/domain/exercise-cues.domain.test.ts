import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getExerciseCues, hasExerciseCues, cuedExerciseIds } from '@kinetic/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const exercises = JSON.parse(
  readFileSync(join(__dirname, '../../apps/web/public/exercises.v1.json'), 'utf8'),
) as Array<{ id: string }>;
const exerciseIds = new Set(exercises.map((e) => e.id));

describe('getExerciseCues', () => {
  it('renvoie null pour un exercice inconnu', () => {
    expect(getExerciseCues('does_not_exist')).toBeNull();
    expect(hasExerciseCues('does_not_exist')).toBe(false);
  });

  it('renvoie des consignes complètes pour un mouvement connu', () => {
    const c = getExerciseCues('sq');
    expect(c).not.toBeNull();
    expect(c!.execution.length).toBeGreaterThan(0);
    expect(c!.mistakes.length).toBeGreaterThan(0);
    expect(c!.tips.length).toBeGreaterThan(0);
    expect(hasExerciseCues('sq')).toBe(true);
  });

  it('chaque exercice documenté a exécution + erreurs + conseils non vides', () => {
    for (const id of cuedExerciseIds()) {
      const c = getExerciseCues(id)!;
      expect(c.execution.length, `${id}.execution`).toBeGreaterThan(0);
      expect(c.mistakes.length, `${id}.mistakes`).toBeGreaterThan(0);
      expect(c.tips.length, `${id}.tips`).toBeGreaterThan(0);
      // pas de chaîne vide
      for (const line of [...c.execution, ...c.mistakes, ...c.tips]) {
        expect(line.trim().length, `${id} ligne vide`).toBeGreaterThan(0);
      }
    }
  });

  it('toutes les clés de consignes correspondent à un exercice réel (anti-typo)', () => {
    const unknown = cuedExerciseIds().filter((id) => !exerciseIds.has(id));
    expect(unknown, `ids inconnus: ${unknown.join(', ')}`).toEqual([]);
  });

  it('documente une couverture significative des exercices courants', () => {
    expect(cuedExerciseIds().length).toBeGreaterThanOrEqual(25);
  });
});
