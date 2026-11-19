import { describe, it, expect } from 'vitest';
import { buildShareCardSummary, sessionDurationKnown, shareCardTitle } from '@kinetic/core';
import { fitTitle } from '../../apps/web/src/lib/session-share-image.js';

describe('shareCardTitle', () => {
  it('retire la date redondante en fin de nom', () => {
    expect(shareCardTitle('Séance libre (mer. 18 nov.)')).toBe('Séance libre');
    expect(shareCardTitle('Push (18/11)')).toBe('Push');
    expect(shareCardTitle('Jambes — 18/11')).toBe('Jambes');
    expect(shareCardTitle('Haut · mer. 18 nov.')).toBe('Haut');
  });
  it('garde une parenthèse qui n’est pas une date', () => {
    expect(shareCardTitle('Full body (version courte)')).toBe('Full body (version courte)');
    expect(shareCardTitle('Push A - Force')).toBe('Push A - Force');
  });
  it('vide ou date seule → « Séance »', () => {
    expect(shareCardTitle('   ')).toBe('Séance');
    expect(shareCardTitle('(mer. 18 nov.)')).toBe('(mer. 18 nov.)');
    expect(shareCardTitle('  Dos   lourd ')).toBe('Dos lourd');
  });
});

describe('durée sur la carte', () => {
  const base = { id: 's', name: 'Séance libre (mer. 18 nov.)', entries: [] };
  it('séance de quelques secondes → « < 1 min »', () => {
    const sum = buildShareCardSummary(
      { ...base, startedAt: '2026-11-18T10:00:00Z', endedAt: '2026-11-18T10:00:20Z' },
      [],
      (id) => id,
      'square',
    );
    expect(sum.duration).toEqual({ value: '< 1', unit: 'min' });
    expect(sum.title).toBe('Séance libre');
  });
  it('fin inconnue → « — »', () => {
    expect(sessionDurationKnown({ ...base, startedAt: '2026-11-18T10:00:00Z' })).toBe(false);
  });
});

describe('fitTitle', () => {
  // Police fictive : chaque caractère fait size/2 px.
  const measureAt = (size: number) => (t: string) => t.length * (size / 2);
  it('réduit la taille pour tenir sur une ligne', () => {
    const r = fitTitle('Séance libre', 360, 78, 58, measureAt); // 12 car.
    expect(r.lines).toEqual(['Séance libre']);
    expect(r.size).toBeLessThan(78);
    expect(r.size * 6).toBeLessThanOrEqual(360);
  });
  it('garde la grande taille si ça tient', () => {
    expect(fitTitle('Push', 300, 78, 58, measureAt)).toEqual({ size: 78, lines: ['Push'] });
  });
  it('sinon deux lignes à la taille maximale', () => {
    const r = fitTitle('Haut du corps lourd avec accessoires', 300, 78, 58, measureAt);
    expect(r.size).toBe(78);
    expect(r.lines.length).toBeLessThanOrEqual(2);
  });
});
