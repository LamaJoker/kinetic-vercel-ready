import { describe, it, expect } from 'vitest';
import {
  GLOSSARY,
  getGlossaryTerm,
  searchGlossary,
  glossaryCategories,
} from '../../packages/core/src/domain/glossary.domain.js';

describe('GLOSSARY', () => {
  it('contient les termes essentiels', () => {
    const ids = GLOSSARY.map((t) => t.id);
    for (const id of [
      'rpe',
      'e1rm',
      '1rm',
      'amrap',
      'tonnage',
      'deload',
      'sbd',
      'wilks',
      'tempo',
      'emom',
      'pr',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('chaque terme a un short non vide et un long plus détaillé', () => {
    for (const t of GLOSSARY) {
      expect(t.short.length).toBeGreaterThan(0);
      expect(t.long.length).toBeGreaterThanOrEqual(t.short.length);
      expect(t.term.length).toBeGreaterThan(0);
    }
  });

  it('les ids sont uniques', () => {
    const ids = GLOSSARY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getGlossaryTerm', () => {
  it('retourne le terme pour un id valide', () => {
    expect(getGlossaryTerm('rpe')?.term).toBe('RPE');
  });

  it('retourne null pour un id inconnu', () => {
    expect(getGlossaryTerm('does-not-exist')).toBeNull();
  });
});

describe('searchGlossary', () => {
  it('query vide retourne tout', () => {
    expect(searchGlossary('').length).toBe(GLOSSARY.length);
  });

  it('trouve par terme (insensible casse/accents)', () => {
    const res = searchGlossary('rpe');
    expect(res.some((t) => t.id === 'rpe')).toBe(true);
  });

  it('trouve "deload" via le contenu long', () => {
    const res = searchGlossary('surentraînement');
    expect(res.some((t) => t.id === 'deload')).toBe(true);
  });

  it('insensible aux accents', () => {
    const withAccent = searchGlossary('intensité');
    const without = searchGlossary('intensite');
    expect(without.length).toBe(withAccent.length);
  });

  it('retourne vide pour une recherche sans correspondance', () => {
    expect(searchGlossary('zzzzqxqx')).toEqual([]);
  });
});

describe('glossaryCategories', () => {
  it('retourne les catégories présentes dans un ordre lisible', () => {
    const cats = glossaryCategories();
    expect(cats.length).toBeGreaterThan(0);
    // Toutes les catégories retournées existent vraiment dans le glossaire
    const present = new Set(GLOSSARY.map((t) => t.category));
    for (const c of cats) expect(present.has(c)).toBe(true);
  });
});
