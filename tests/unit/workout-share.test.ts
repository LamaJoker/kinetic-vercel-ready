import { describe, it, expect } from 'vitest';
import {
  encodeWorkout,
  decodeWorkout,
  buildShareUrl,
} from '../../packages/core/src/domain/workout-share.domain.js';

const sample = {
  name: 'Push A — Hypertrophie',
  exercises: [
    { exerciseId: 'bp', sets: 4, targetReps: 8, targetRpe: 8 },
    { exerciseId: 'ohp', sets: 3, targetReps: 10, targetRpe: 7.5 },
  ],
};

describe('encodeWorkout / decodeWorkout', () => {
  it('roundtrip identité', () => {
    const token = encodeWorkout(sample);
    const decoded = decodeWorkout(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe(sample.name);
    expect(decoded!.exercises).toEqual(sample.exercises);
  });

  it('produit un token compact préfixé v1.', () => {
    const token = encodeWorkout(sample);
    expect(token.startsWith('v1.')).toBe(true);
    expect(token.length).toBeLessThan(300);
  });

  it('décode null sur token sans préfixe', () => {
    expect(decodeWorkout('not-a-token')).toBeNull();
    expect(decodeWorkout('v2.abcd')).toBeNull();
  });

  it('décode null sur base64 corrompu', () => {
    expect(decodeWorkout('v1.!!!not-valid-base64!!!')).toBeNull();
  });

  it('décode null si JSON invalide', () => {
    // "abc" encodé en base64url
    const corrupt = `v1.${btoa('abc').replace(/\+/g, '-').replace(/\//g, '_')}`;
    expect(decodeWorkout(corrupt)).toBeNull();
  });

  it('clamp les valeurs aberrantes', () => {
    const naughty = encodeWorkout({
      name: 'Test',
      exercises: [{ exerciseId: 'bp', sets: 99, targetReps: 999, targetRpe: 42 }],
    });
    const decoded = decodeWorkout(naughty)!;
    expect(decoded.exercises[0]!.sets).toBeLessThanOrEqual(20);
    expect(decoded.exercises[0]!.targetReps).toBeLessThanOrEqual(50);
    expect(decoded.exercises[0]!.targetRpe).toBeLessThanOrEqual(10);
  });

  it('gère les caractères Unicode (accents, emoji)', () => {
    const utf = {
      name: 'Séance "Légende" 💪',
      exercises: [{ exerciseId: 'bp', sets: 3, targetReps: 8, targetRpe: 8 }],
    };
    const decoded = decodeWorkout(encodeWorkout(utf))!;
    expect(decoded.name).toBe(utf.name);
  });
});

describe('buildShareUrl', () => {
  it('produit une URL absolue avec query encoding', () => {
    const token = encodeWorkout(sample);
    const url = buildShareUrl('https://example.com', token);
    expect(url).toMatch(/^https:\/\/example\.com\/\?import=/);
    expect(url).not.toContain('//?'); // pas de double slash
  });

  it('trim trailing slash de origin', () => {
    const url = buildShareUrl('https://example.com/', 'v1.abc');
    expect(url).toBe('https://example.com/?import=v1.abc');
  });
});
