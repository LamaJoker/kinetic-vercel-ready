import { describe, it, expect } from 'vitest';
import {
  detectPlateau,
  dismissPlateau,
  isPlateauDismissed,
  plateauSuggestions,
  type PlateauSession,
} from '@kinetic/core';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

function ohp(daysAgo: number, kg: number, reps = 8, rpe = 8, warmupKg = 0): PlateauSession {
  return {
    startedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    entries: [
      {
        exerciseId: 'ohp',
        sets: [
          ...(warmupKg ? [{ weightKg: warmupKg, reps: 8, rpe: 6, kind: 'warmup' as const }] : []),
          { weightKg: kg, reps, rpe },
          { weightKg: kg, reps: reps - 1, rpe },
        ],
      },
    ],
  };
}

describe('detectPlateau', () => {
  it('plateau : 4 séances sans progrès d’e1RM ni de meilleure série', () => {
    const sessions = [ohp(30, 45), ohp(24, 47.5), ohp(17, 47.5), ohp(10, 47.5, 7), ohp(3, 47.5)];
    const p = detectPlateau(sessions, 'ohp', { now: NOW, incrementKg: 1.25 })!;
    expect(p).not.toBeNull();
    expect(p.sessions).toBe(4);
    expect(p.since).toBe(sessions[1]!.startedAt);
    expect(p.topKg).toBe(47.5);
    expect(p.topReps).toBe(8);
    expect(p.suggestions.map((s) => s.id)).toEqual([
      'reps-range',
      'micro-load',
      'variant',
      'deload',
    ]);
  });

  it('pas de plateau tant que la charge ou les reps montent', () => {
    const sessions = [
      ohp(30, 45),
      ohp(24, 45, 9),
      ohp(17, 47.5, 6),
      ohp(10, 47.5, 7),
      ohp(3, 47.5, 8),
    ];
    expect(detectPlateau(sessions, 'ohp', { now: NOW })).toBeNull();
  });

  it('ignore les échauffements (une série d’échauffement lourde ne crée pas de progrès)', () => {
    const sessions = [ohp(24, 47.5), ohp(17, 47.5, 8, 8, 60), ohp(10, 47.5), ohp(3, 47.5)];
    expect(detectPlateau(sessions, 'ohp', { now: NOW })?.sessions).toBe(4);
  });

  it('ignore les séances anciennes et une reprise après une pause', () => {
    const old = [ohp(120, 47.5), ohp(110, 47.5), ohp(100, 47.5), ohp(90, 47.5)];
    expect(detectPlateau(old, 'ohp', { now: NOW })).toBeNull();
    // Dans la fenêtre, mais la dernière séance date de plus de 4 semaines
    const paused = [ohp(55, 47.5), ohp(48, 47.5), ohp(41, 47.5), ohp(34, 47.5)];
    expect(detectPlateau(paused, 'ohp', { now: NOW })).toBeNull();
  });

  it('séances rapprochées (même semaine) : pas encore un plateau', () => {
    const sessions = [ohp(8, 47.5), ohp(7, 47.5), ohp(6, 47.5), ohp(5, 47.5), ohp(4, 47.5)];
    expect(detectPlateau(sessions, 'ohp', { now: NOW })).toBeNull();
  });

  it('exercice fait 2 fois seulement : jamais d’alerte', () => {
    expect(detectPlateau([ohp(20, 47.5), ohp(3, 47.5)], 'ohp', { now: NOW })).toBeNull();
  });

  it('masqué : reste masqué jusqu’à la fin du délai, pour cet exercice seulement', () => {
    const d = dismissPlateau({}, 'ohp', NOW);
    expect(isPlateauDismissed(d, 'ohp', NOW + 20 * DAY)).toBe(true);
    expect(isPlateauDismissed(d, 'bp', NOW)).toBe(false);
    expect(isPlateauDismissed(d, 'ohp', NOW + 22 * DAY)).toBe(false);
  });

  it('trop peu de séances : pas d’alerte', () => {
    expect(detectPlateau([ohp(10, 47.5), ohp(3, 47.5)], 'ohp', { now: NOW })).toBeNull();
  });

  it('RPE élevé : la semaine plus légère passe en premier, chiffrée', () => {
    const sessions = [ohp(24, 50, 6, 9), ohp(17, 50, 6, 9.5), ohp(10, 50, 6, 9), ohp(3, 50, 6, 9)];
    const p = detectPlateau(sessions, 'ohp', { now: NOW, incrementKg: 2.5 })!;
    expect(p.avgRpe).toBeGreaterThanOrEqual(9);
    expect(p.suggestions[0]!.id).toBe('deload');
    expect(p.suggestions[0]!.detail).toContain('45 kg');
    // Reps basses → plage plus haute
    expect(p.suggestions[1]!.title).toBe('Passe à 8–10 reps');
  });
});

describe('plateauSuggestions', () => {
  it('reps hautes → plage plus lourde, micro-charge = moitié du pas', () => {
    const s = plateauSuggestions(
      { bestE1rm: 60, topKg: 47.5, sessions: 4, avgRpe: 7.5 },
      2.5,
      [10, 10, 9],
    );
    expect(s[0]!.title).toBe('Passe à 4–6 reps');
    expect(s[1]!.title).toBe('Micro-charges : +1,25 kg');
  });

  it('poids du corps : lest léger plutôt que micro-disques', () => {
    const s = plateauSuggestions({ bestE1rm: 0, topKg: 0, sessions: 4, avgRpe: null }, 2.5, [12]);
    expect(s.map((x) => x.id)).toEqual(['micro-load', 'variant', 'deload']);
    expect(s[0]!.title).toBe('Ajoute un lest léger');
  });
});

describe('masquer l’alerte', () => {
  it('masquée quelques semaines puis de retour ; les masquages expirés sont retirés', () => {
    const d = dismissPlateau({ old: new Date(NOW - DAY).toISOString() }, 'ohp', NOW);
    expect(Object.keys(d)).toEqual(['ohp']);
    expect(isPlateauDismissed(d, 'ohp', NOW + 20 * DAY)).toBe(true);
    expect(isPlateauDismissed(d, 'ohp', NOW + 22 * DAY)).toBe(false);
    expect(isPlateauDismissed(d, 'sq', NOW)).toBe(false);
    expect(isPlateauDismissed(null, 'ohp', NOW)).toBe(false);
  });
});
