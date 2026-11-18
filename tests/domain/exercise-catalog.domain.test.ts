import { describe, it, expect } from 'vitest';
import { EXERCISE_CATALOG_VERSION, mergeCatalog, needsCatalogUpdate } from '@kinetic/core';

interface Ex {
  id: string;
  name: string;
  incrementKg: number;
  custom?: boolean;
  hidden?: boolean;
}

const ex = (id: string, name = id, extra: Partial<Ex> = {}): Ex => ({
  id,
  name,
  incrementKg: 2.5,
  ...extra,
});

describe('needsCatalogUpdate', () => {
  it('demande une mise à jour sans version ou avec une version plus ancienne', () => {
    expect(needsCatalogUpdate(null)).toBe(true);
    expect(needsCatalogUpdate(undefined)).toBe(true);
    expect(needsCatalogUpdate('2')).toBe(true);
    expect(needsCatalogUpdate(EXERCISE_CATALOG_VERSION - 1)).toBe(true);
    expect(needsCatalogUpdate(EXERCISE_CATALOG_VERSION)).toBe(false);
  });
});

describe('mergeCatalog', () => {
  it('ajoute les nouveaux exercices du catalogue', () => {
    const r = mergeCatalog([ex('sq')], [ex('sq'), ex('dl')]);
    expect(r.map((e) => e.id)).toEqual(['sq', 'dl']);
  });

  it('applique les corrections du catalogue en gardant les préférences', () => {
    const r = mergeCatalog(
      [ex('sq', 'Back Sqaut', { hidden: true, incrementKg: 5 })],
      [ex('sq', 'Back Squat')],
    );
    expect(r).toEqual([{ id: 'sq', name: 'Back Squat', incrementKg: 2.5, hidden: true }]);
  });

  it('conserve les exercices absents du catalogue (importés, perso) après le catalogue', () => {
    const imported = ex('strong-row', 'Row');
    const mine = ex('custom-1', 'Mon exo', { custom: true });
    const r = mergeCatalog([imported, ex('sq'), mine], [ex('sq'), ex('bp')]);
    expect(r.map((e) => e.id)).toEqual(['sq', 'bp', 'strong-row', 'custom-1']);
  });

  it("n'écrase jamais un exercice perso de même id", () => {
    const mine = ex('bp', 'Mon développé', { custom: true, incrementKg: 1 });
    expect(mergeCatalog([mine], [ex('bp', 'Bench Press')])).toEqual([mine]);
  });

  it('ignore les doublons du catalogue et ne modifie pas les entrées', () => {
    const stored = [ex('sq')];
    const r = mergeCatalog(stored, [ex('sq', 'A'), ex('sq', 'B')]);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('A');
    expect(stored[0]!.name).toBe('sq');
  });
});
