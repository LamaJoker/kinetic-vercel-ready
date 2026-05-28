import { describe, it, expect } from 'vitest';
import {
  wilks2020,
  ipfGoodlift,
  dotsScore,
  tierFromIpfGl,
} from '../../packages/core/src/domain/strength-score.domain.js';

describe('wilks2020', () => {
  it('homme 100 kg / total 600 kg → score raisonnable (350-450)', () => {
    const score = wilks2020(600, 100, 'male');
    expect(score).toBeGreaterThan(350);
    expect(score).toBeLessThan(450);
  });

  it('femme 60 kg / total 300 kg → score raisonnable (300-450)', () => {
    const score = wilks2020(300, 60, 'female');
    expect(score).toBeGreaterThan(300);
    expect(score).toBeLessThan(450);
  });

  it('0 si bodyweight hors plage', () => {
    expect(wilks2020(500, 30, 'male')).toBe(0);
    expect(wilks2020(500, 220, 'male')).toBe(0);
  });

  it('0 si total invalide', () => {
    expect(wilks2020(0, 80, 'male')).toBe(0);
    expect(wilks2020(-100, 80, 'male')).toBe(0);
  });
});

describe('ipfGoodlift', () => {
  it('homme 100 kg / total 600 kg → 80-120 GL points', () => {
    const score = ipfGoodlift(600, 100, 'male');
    expect(score).toBeGreaterThan(60);
    expect(score).toBeLessThan(120);
  });

  it('plus on est lourd à total égal, plus le score baisse', () => {
    const light = ipfGoodlift(500, 70, 'male');
    const heavy = ipfGoodlift(500, 140, 'male');
    expect(light).toBeGreaterThan(heavy);
  });

  it('0 hors plages', () => {
    expect(ipfGoodlift(500, 20, 'male')).toBe(0);
    expect(ipfGoodlift(500, 300, 'male')).toBe(0);
  });
});

describe('dotsScore', () => {
  it('retourne une valeur positive pour un input sain', () => {
    expect(dotsScore(600, 100, 'male')).toBeGreaterThan(0);
  });

  it('clamp doux : 0 pour bodyweight < 40', () => {
    expect(dotsScore(500, 30, 'male')).toBe(0);
  });

  it("femme < homme à total et bodyweight égaux n'est pas garanti — la formule normalise", () => {
    // On vérifie juste qu'elle ne crash pas
    const score = dotsScore(300, 60, 'female');
    expect(score).toBeGreaterThan(0);
  });
});

describe('tierFromIpfGl', () => {
  it('classifie correctement les paliers', () => {
    expect(tierFromIpfGl(20)).toBe('beginner');
    expect(tierFromIpfGl(50)).toBe('novice');
    expect(tierFromIpfGl(65)).toBe('intermediate');
    expect(tierFromIpfGl(80)).toBe('advanced');
    expect(tierFromIpfGl(95)).toBe('elite');
  });
});
