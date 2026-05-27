import { describe, it, expect } from 'vitest';
import { buildHeatmap } from '../../packages/core/src/domain/heatmap.domain.js';

describe('buildHeatmap', () => {
  it('produit `weeks` semaines de 7 jours', () => {
    const r = buildHeatmap([], 8, new Date('2026-05-27T10:00:00'));
    expect(r.weeks).toHaveLength(8);
    for (const w of r.weeks) {
      expect(w.days).toHaveLength(7);
    }
  });

  it('compte les séances dans la fenêtre par jour LOCAL', () => {
    const now = new Date('2026-05-27T10:00:00'); // mercredi
    // 2 séances aujourd'hui, 1 hier
    const r = buildHeatmap(
      ['2026-05-27T08:00:00', '2026-05-27T18:00:00', '2026-05-26T20:00:00'],
      4,
      now,
    );
    expect(r.totalSessions).toBe(3);
    expect(r.activeDays).toBe(2);
    // Vérif le jour le plus actif a 2 séances
    expect(r.bestDay?.count).toBe(2);
  });

  it('ignore les séances hors de la fenêtre', () => {
    const now = new Date('2026-05-27T10:00:00');
    const r = buildHeatmap(
      ['2026-01-01T08:00:00'], // hors fenêtre 8 sem
      8,
      now,
    );
    expect(r.totalSessions).toBe(0);
    expect(r.bestDay).toBeNull();
  });

  it("classe l'intensité en niveaux 0-4", () => {
    const now = new Date('2026-05-27T10:00:00');
    const r = buildHeatmap(
      ['2026-05-27T08:00:00', '2026-05-27T18:00:00', '2026-05-27T22:00:00', '2026-05-27T23:00:00'],
      1,
      now,
    );
    // 4 séances le même jour → level 4
    const day = r.weeks[0]!.days.find((d) => d.count === 4);
    expect(day?.level).toBe(4);
  });
});
