/**
 * Régression : le premier rendu Alpine lisait les getters avant le chargement
 * des séances et mettait une liste vide en cache → bilan hebdo, régularité et
 * courbe e1RM restaient vides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';

const storage = new InMemoryStorage();
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({ storage })),
}));

const { progression } = await import('../../apps/web/src/pages/progression.page.js');
const { loadDemoData } = await import('../../apps/web/src/lib/demo.js');

describe('page progression', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    await storage.clear();
    await storage.set('kinetic:training:exercises', [
      { id: 'bp', name: 'Bench', muscles: ['chest'], equipment: 'barbell', incrementKg: 2.5 },
    ]);
    await loadDemoData(storage, new Date());
  });

  it('recalcule les statistiques après le chargement des séances', async () => {
    const page = progression() as unknown as {
      init(): Promise<void>;
      consistency: number;
      selectedExerciseId: string;
      totalSessions: number;
    };
    const loading = page.init(); // x-init lance le chargement…
    expect(page.consistency).toBe(0); // …et Alpine lit les getters pendant l'attente
    await loading;
    expect(page.totalSessions).toBeGreaterThan(20);
    expect(page.consistency).toBeGreaterThan(50);
    expect(page.selectedExerciseId).not.toBe('');
  });
});
