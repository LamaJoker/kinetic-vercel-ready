import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXERCISE_NAMES_FR,
  exerciseDisplayName,
  localizeExercises,
} from '../../apps/web/src/lib/training/exercise-names-fr.js';
import { DEFAULT_EXERCISES } from '../../apps/web/src/lib/training/seed.js';
import { loadExercises } from '../../apps/web/src/lib/training/storage.js';
import { InMemoryStorage } from '../helpers/stubs.js';

const catalog = JSON.parse(
  readFileSync(resolve(__dirname, '../../apps/web/public/exercises.v1.json'), 'utf8'),
) as Array<{ id: string; name: string }>;

describe('noms d exercices en français', () => {
  it('couvre tout le catalogue et le seed, avec le nom anglais exact', () => {
    for (const ex of [...catalog, ...DEFAULT_EXERCISES]) {
      const entry = EXERCISE_NAMES_FR[ex.id];
      expect(entry, ex.id).toBeDefined();
      expect(entry![0], ex.id).toBe(ex.name);
    }
  });

  it('traduit un nom d origine, jamais un nom personnalisé', () => {
    expect(exerciseDisplayName('bp', 'Bench Press')).toBe('Développé couché');
    expect(exerciseDisplayName('bp', 'Mon DC pause')).toBe('Mon DC pause');
    expect(exerciseDisplayName('import-xyz', 'Bench Press (Barbell)')).toBe(
      'Bench Press (Barbell)',
    );
  });

  it('loadExercises renvoie des noms français sans réécrire le stockage', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:training:exercises', [
      { id: 'dl', name: 'Deadlift', muscles: ['back'], equipment: 'barbell', incrementKg: 5 },
    ]);
    const list = await loadExercises(storage);
    expect(list[0]!.name).toBe('Soulevé de terre');
    const stored = await storage.get<Array<{ name: string }>>('kinetic:training:exercises');
    expect(stored![0]!.name).toBe('Deadlift');
  });

  it('localizeExercises conserve la référence quand rien ne change', () => {
    const custom = [
      { id: 'x', name: 'Perso', muscles: [], equipment: 'other' as const, incrementKg: 1 },
    ];
    expect(localizeExercises(custom)[0]).toBe(custom[0]);
  });
});
