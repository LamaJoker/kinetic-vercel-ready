import { describe, it, expect } from 'vitest';
import {
  parseTextSizePref,
  textBaseCss,
  textBasePx,
  TEXT_SIZE_LABELS,
  TEXT_SIZE_PREFS,
  TEXT_BASE_MAX_PX,
  TEXT_BASE_MIN_PX,
} from '@kinetic/core';

describe('parseTextSizePref', () => {
  it('accepte les quatre réglages', () => {
    for (const p of TEXT_SIZE_PREFS) expect(parseTextSizePref(p)).toBe(p);
  });
  it('revient à « Système » pour une valeur inconnue', () => {
    expect(parseTextSizePref(null)).toBe('system');
    expect(parseTextSizePref('huge')).toBe('system');
    expect(parseTextSizePref(18)).toBe('system');
  });
  it('a un libellé français pour chaque réglage', () => {
    expect(TEXT_SIZE_LABELS).toEqual({
      system: 'Système',
      normal: 'Normal',
      large: 'Grand',
      xlarge: 'Très grand',
    });
  });
});

describe('textBasePx', () => {
  it('fixe la base pour Normal / Grand / Très grand, quel que soit le système', () => {
    expect(textBasePx('normal', 28)).toBe(16);
    expect(textBasePx('large', null)).toBe(18);
    expect(textBasePx('xlarge', 14)).toBe(20);
  });
  it('Système hors iPhone : laisse la taille du navigateur', () => {
    expect(textBasePx('system', null)).toBeNull();
    expect(textBasePx('system', Number.NaN)).toBeNull();
    expect(textBasePx('system', 0)).toBeNull();
  });
  it('Système sur iPhone : 17 px (réglage par défaut) donne 16 px', () => {
    expect(textBasePx('system', 17)).toBe(16);
  });
  it('suit Dynamic Type en restant bornée', () => {
    expect(textBasePx('system', 19)).toBe(18); // 19 × 16 / 17 ≈ 17,9 → arrondi au quart
    expect(textBasePx('system', 14)).toBe(TEXT_BASE_MIN_PX); // 13,2 → borne basse
    expect(textBasePx('system', 53)).toBe(TEXT_BASE_MAX_PX); // tailles d'accessibilité
  });
});

describe('textBaseCss', () => {
  it('exprime la base en pourcentage (compose avec le zoom du navigateur)', () => {
    expect(textBaseCss(16)).toBe('100%');
    expect(textBaseCss(20)).toBe('125%');
    expect(textBaseCss(18)).toBe('112.5%');
  });
  it('chaîne vide = pas de surcharge', () => {
    expect(textBaseCss(null)).toBe('');
  });
});
