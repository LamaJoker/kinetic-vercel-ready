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

  it('présentation : anneau de régularité, barres et médaillons', async () => {
    const page = progression() as unknown as {
      init(): Promise<void>;
      consistency: number;
      consistencyRingStyle: string;
      weeklyBuckets: unknown[];
      barClass(i: number): string;
      prGlyphClass(i: number): string;
      forceSvg(): string;
    };
    expect(page.consistencyRingStyle).toBe('--p: 0');
    await page.init();
    expect(page.consistencyRingStyle).toBe(`--p: ${Math.min(100, Math.round(page.consistency))}`);
    const last = page.weeklyBuckets.length - 1;
    expect(page.barClass(last)).toContain('to-kinetic-neon');
    expect(page.barClass(0)).toBe('bg-kinetic-neon/30');
    expect(page.prGlyphClass(0)).toContain('kinetic-gold');
    expect(page.prGlyphClass(1)).toContain('text-kinetic-neon');
    // x-svg retire les attributs style : la courbe suit l'accent par currentColor
    const svg = page.forceSvg();
    expect(svg).toContain('class="text-kinetic-neon"');
    expect(svg).not.toMatch(/style="(fill|stroke|stop)/);
  });
});
