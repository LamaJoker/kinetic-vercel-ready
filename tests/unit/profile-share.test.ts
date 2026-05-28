import { describe, it, expect } from 'vitest';
import {
  encodeProfile,
  decodeProfile,
  buildProfileShareUrl,
  type SharedProfile,
} from '../../packages/core/src/domain/profile-share.domain.js';

const sample: SharedProfile = {
  pseudo: 'Valentin',
  level: 7,
  streak: 21,
  totalSessions: 142,
  bestLifts: [
    { exerciseId: 'Back Squat', weightKg: 160, reps: 3, e1rmKg: 176 },
    { exerciseId: 'Bench Press', weightKg: 110, reps: 5, e1rmKg: 128.3 },
    { exerciseId: 'Deadlift', weightKg: 200, reps: 2, e1rmKg: 213.3 },
  ],
};

describe('encodeProfile / decodeProfile', () => {
  it('roundtrip identité', () => {
    const token = encodeProfile(sample);
    const decoded = decodeProfile(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.pseudo).toBe(sample.pseudo);
    expect(decoded!.level).toBe(sample.level);
    expect(decoded!.streak).toBe(sample.streak);
    expect(decoded!.totalSessions).toBe(sample.totalSessions);
    expect(decoded!.bestLifts).toEqual(sample.bestLifts);
  });

  it('préfixe le token avec kp1.', () => {
    const token = encodeProfile(sample);
    expect(token.startsWith('kp1.')).toBe(true);
  });

  it('refuse un token invalide', () => {
    expect(decodeProfile('garbage')).toBeNull();
    expect(decodeProfile('v1.abc')).toBeNull(); // mauvais préfixe
    expect(decodeProfile('kp1.!!!')).toBeNull(); // base64 invalide
  });

  it('tronque le pseudo à 32 caractères', () => {
    const long = 'a'.repeat(80);
    const decoded = decodeProfile(encodeProfile({ ...sample, pseudo: long }));
    expect(decoded!.pseudo.length).toBe(32);
  });

  it('limite à 10 best lifts', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      exerciseId: `ex-${i}`,
      weightKg: 100,
      reps: 5,
      e1rmKg: 116,
    }));
    const decoded = decodeProfile(encodeProfile({ ...sample, bestLifts: many }));
    expect(decoded!.bestLifts.length).toBe(10);
  });

  it('clamp les valeurs aberrantes', () => {
    const ugly = decodeProfile(
      encodeProfile({
        ...sample,
        level: 9999,
        streak: -5,
        totalSessions: 10_000_000,
      }),
    );
    expect(ugly!.level).toBeLessThanOrEqual(99);
    expect(ugly!.streak).toBeGreaterThanOrEqual(0);
    expect(ugly!.totalSessions).toBeLessThanOrEqual(99999);
  });
});

describe('buildProfileShareUrl', () => {
  it('utilise le query ?profile=', () => {
    const url = buildProfileShareUrl('https://kinetic.app', 'kp1.xxx');
    expect(url).toBe('https://kinetic.app/?profile=kp1.xxx');
  });

  it("enlève le slash final de l'origin", () => {
    const url = buildProfileShareUrl('https://kinetic.app/', 'kp1.xxx');
    expect(url).toBe('https://kinetic.app/?profile=kp1.xxx');
  });

  it('encode le token (qui peut contenir des =)', () => {
    const url = buildProfileShareUrl('https://k.app', 'kp1.A=B');
    expect(url).toContain('kp1.A%3DB');
  });
});
