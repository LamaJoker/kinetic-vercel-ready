import { describe, it, expect } from 'vitest';
import {
  bodyFatCategory,
  bodyFatMasses,
  bodyFatSeries,
  defaultComparePair,
  durationLabel,
  missingNavyInputs,
  navyBodyFatPct,
  navyInputIssue,
  nearestWeight,
  photoGapLabel,
  signedKg,
  splitPercent,
} from '@kinetic/core';

describe('navyBodyFatPct (méthode US Navy)', () => {
  it('homme : 34 in de taille, 15 in de cou, 70 in → ≈ 17,5 % (formule en pouces)', () => {
    // Référence en pouces : 86,010·log10(34 − 15) − 70,041·log10(70) + 36,76 = 17,5 %
    const pct = navyBodyFatPct({ sex: 'male', heightCm: 177.8, waistCm: 86.36, neckCm: 38.1 });
    expect(pct).toBe(17.4);
  });

  it('homme : 84 / 38 cm pour 1,80 m → 15,3 %', () => {
    expect(navyBodyFatPct({ sex: 'male', heightCm: 180, waistCm: 84, neckCm: 38 })).toBe(15.3);
  });

  it('femme : 28 in taille, 38 in hanches, 13 in cou, 65 in → ≈ 25,9 % (pouces)', () => {
    const pct = navyBodyFatPct({
      sex: 'female',
      heightCm: 165.1,
      waistCm: 71.1,
      hipsCm: 96.5,
      neckCm: 33,
    });
    expect(pct).toBe(25.7);
  });

  it('femme sans hanches, mesures manquantes ou incohérentes → null', () => {
    expect(navyBodyFatPct({ sex: 'female', heightCm: 165, waistCm: 70, neckCm: 32 })).toBeNull();
    expect(navyBodyFatPct({ sex: 'male', heightCm: 180, waistCm: 0, neckCm: 38 })).toBeNull();
    expect(navyBodyFatPct({ sex: 'male', heightCm: 180, waistCm: 37, neckCm: 38 })).toBeNull();
    expect(navyBodyFatPct({ sex: 'male', heightCm: 0, waistCm: 84, neckCm: 38 })).toBeNull();
    // Hors plage physiologique
    expect(navyBodyFatPct({ sex: 'male', heightCm: 180, waistCm: 39, neckCm: 38 })).toBeNull();
  });
});

describe('catégories et masses', () => {
  it('catégories homme / femme', () => {
    expect(bodyFatCategory(4, 'male').key).toBe('essential');
    expect(bodyFatCategory(12, 'male').label).toBe('Athlétique');
    expect(bodyFatCategory(15.3, 'male').label).toBe('En forme');
    expect(bodyFatCategory(20, 'male').key).toBe('average');
    expect(bodyFatCategory(25, 'male').key).toBe('high');
    expect(bodyFatCategory(20, 'female').key).toBe('athletic');
    expect(bodyFatCategory(25.7, 'female').key).toBe('average');
    expect(bodyFatCategory(33, 'female').key).toBe('high');
  });

  it('masse grasse et masse maigre', () => {
    expect(bodyFatMasses(80, 15)).toEqual({ fatKg: 12, leanKg: 68 });
    expect(bodyFatMasses(77.6, 15.3)).toEqual({ fatKg: 11.9, leanKg: 65.7 });
  });
});

describe('série et pesées', () => {
  const weights = [
    { date: '2026-09-01', weight: 80 },
    { date: '2026-10-01', weight: 79 },
    { date: '2026-11-20', weight: 77.6 },
  ];

  it('nearestWeight : pesée la plus proche dans la fenêtre', () => {
    expect(nearestWeight(weights, '2026-10-04')).toBe(79);
    expect(nearestWeight(weights, '2026-11-01')).toBeNull();
    expect(nearestWeight(weights, '2026-11-01', 31)).toBe(77.6);
  });

  it('bodyFatSeries : ignore les mesures incomplètes, trie, ajoute les masses', () => {
    const s = bodyFatSeries(
      [
        { date: '2026-11-20', waist: 81.6, neck: 38.4 },
        { date: '2026-09-01', waist: 84, neck: 38 },
        { date: '2026-10-15', waist: 83 },
      ],
      weights,
      { sex: 'male', heightCm: 180 },
    );
    expect(s.map((p) => p.date)).toEqual(['2026-09-01', '2026-11-20']);
    expect(s[0]).toMatchObject({ pct: 15.3, weightKg: 80, fatKg: 12.2, leanKg: 67.8 });
    expect(s[1]!.pct).toBe(13.1);
    expect(bodyFatSeries([{ date: '2026-09-01', waist: 84, neck: 38 }], weights, null)).toEqual([]);
  });

  it('missingNavyInputs', () => {
    expect(missingNavyInputs({ date: 'x', waist: 84 }, { sex: 'male', heightCm: 180 })).toEqual([
      'le tour de cou',
    ]);
    expect(missingNavyInputs(null, { sex: 'female', heightCm: 165 })).toEqual([
      'le tour de cou',
      'le tour de taille',
      'le tour de hanches',
    ]);
    expect(missingNavyInputs({ date: 'x', waist: 84, neck: 38 }, null)).toEqual([
      'ta taille (profil)',
    ]);
  });
});

describe('comparateur de photos', () => {
  const photos = [
    { id: 'a', takenAt: '2026-08-01T10:00:00Z', label: 'front', bodyweightKg: 80.4 },
    { id: 'b', takenAt: '2026-08-02T10:00:00Z', label: 'side' },
    { id: 'c', takenAt: '2026-09-15T10:00:00Z', label: 'front' },
    { id: 'd', takenAt: '2026-10-24T10:00:00Z', label: 'front', bodyweightKg: 77.2 },
  ];

  it('paire par défaut : plus ancienne et plus récente de la même pose', () => {
    expect(defaultComparePair(photos)).toEqual({ beforeId: 'a', afterId: 'd' });
    // Dernière photo seule de sa pose → pose la plus fournie
    expect(
      defaultComparePair([...photos, { id: 'e', takenAt: '2026-11-01T10:00:00Z', label: 'back' }]),
    ).toEqual({ beforeId: 'a', afterId: 'd' });
    // Aucune pose en double → toutes poses confondues
    expect(defaultComparePair([photos[0]!, photos[1]!])).toEqual({
      beforeId: 'a',
      afterId: 'b',
    });
    expect(defaultComparePair([photos[0]!])).toBeNull();
  });

  it('durées lisibles', () => {
    expect(durationLabel('2026-08-01', '2026-08-01')).toBe('le même jour');
    expect(durationLabel('2026-08-01', '2026-08-02')).toBe('1 jour');
    expect(durationLabel('2026-08-01', '2026-08-11')).toBe('10 jours');
    expect(durationLabel('2026-08-01T10:00:00Z', '2026-10-24T10:00:00Z')).toBe('12 semaines');
    expect(durationLabel('2026-01-01', '2026-08-01')).toBe('7 mois');
    expect(durationLabel('2023-01-01', '2026-01-01')).toBe('3 ans');
  });

  it('écart « 12 semaines · −3,2 kg », poids de la photo puis de la pesée proche', () => {
    expect(photoGapLabel(photos[0]!, photos[3]!)).toBe('12 semaines · −3,2 kg');
    expect(photoGapLabel(photos[0]!, photos[2]!)).toBe('6 semaines');
    expect(photoGapLabel(photos[0]!, photos[2]!, [{ date: '2026-09-14', weight: 79.1 }])).toBe(
      '6 semaines · −1,3 kg',
    );
  });

  it('signedKg et splitPercent', () => {
    expect(signedKg(0.42)).toBe('+0,4 kg');
    expect(signedKg(-0.01)).toBe('0,0 kg');
    expect(splitPercent(150, 100, 200)).toBe(25);
    expect(splitPercent(-50, 0, 200)).toBe(0);
    expect(splitPercent(500, 0, 200)).toBe(100);
    expect(splitPercent(10, 0, 0)).toBe(50);
  });
});

describe('navyInputIssue (mesures incohérentes)', () => {
  const man = { sex: 'male' as const, heightCm: 178 };
  it('taille ≤ cou : message clair au lieu de NaN', () => {
    expect(navyBodyFatPct({ ...man, waistCm: 38, neckCm: 40 })).toBeNull();
    expect(navyInputIssue({ date: '2026-11-01', waist: 38, neck: 40 }, man)).toContain(
      'plus grand que le tour de cou',
    );
  });
  it('taille de profil improbable', () => {
    expect(
      navyInputIssue({ date: '2026-11-01', waist: 85, neck: 38 }, { sex: 'male', heightCm: 17 }),
    ).toContain('17 cm');
  });
  it('mesures valides ou incomplètes : rien à signaler', () => {
    expect(navyInputIssue({ date: '2026-11-01', waist: 85, neck: 38 }, man)).toBeNull();
    expect(navyInputIssue({ date: '2026-11-01', waist: 85 }, man)).toBeNull();
    expect(navyInputIssue(null, man)).toBeNull();
  });
});
