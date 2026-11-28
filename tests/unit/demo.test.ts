import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  buildDemoData,
  loadDemoData,
  clearDemoData,
  isDemoActive,
} from '../../apps/web/src/lib/demo.js';
import { loadSessions } from '../../apps/web/src/lib/training/storage.js';
import { buildTrainingSnapshot } from '../../apps/web/src/lib/training/next-session.js';
import { DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';

const NOW = new Date(2026, 8, 27, 12, 0); // dimanche

describe('données de démo', () => {
  it('est déterministe', () => {
    expect(buildDemoData(NOW)).toEqual(buildDemoData(NOW));
  });

  it('génère ~8 semaines de séances terminées, jamais dans le futur', () => {
    const { sessions } = buildDemoData(NOW);
    expect(sessions.length).toBeGreaterThanOrEqual(26);
    expect(sessions.length).toBeLessThanOrEqual(32);
    for (const s of sessions) {
      expect(Date.parse(s.startedAt)).toBeLessThan(NOW.getTime());
      expect(s.endedAt).toBeDefined();
      expect(s.entries.every((e) => e.sets.length > 0)).toBe(true);
    }
  });

  it('montre une surcharge progressive au développé couché', () => {
    const { sessions } = buildDemoData(NOW);
    const bench = sessions
      .flatMap((s) => s.entries)
      .filter((e) => e.exerciseId === 'bp')
      .map((e) => e.sets[0]!.weightKg);
    expect(bench[bench.length - 1]!).toBeGreaterThan(bench[0]!);
  });

  it('se charge puis se retire sans toucher aux autres données', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:settings', { theme: 'dark' });

    const count = await loadDemoData(storage, NOW);
    expect(await isDemoActive(storage)).toBe(true);
    const sessions = await loadSessions(storage);
    expect(sessions).toHaveLength(count);

    const snap = buildTrainingSnapshot(sessions, DEFAULT_TEMPLATES, NOW);
    expect(snap.last).not.toBeNull();
    expect(snap.next).not.toBeNull();

    await clearDemoData(storage);
    expect(await isDemoActive(storage)).toBe(false);
    expect(await loadSessions(storage)).toHaveLength(0);
    expect(await storage.keys()).toEqual(['kinetic:settings']);
  });

  it('retire aussi la séance en cours commencée pendant la démo', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, NOW);
    await storage.set('kinetic:training:active-session', { v: 1 });
    await clearDemoData(storage);
    expect(await storage.get('kinetic:training:active-session')).toBeNull();
  });

  it('ne touche pas à la séance en cours hors démo', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:training:active-session', { v: 1 });
    await clearDemoData(storage);
    expect(await storage.get('kinetic:training:active-session')).toEqual({ v: 1 });
  });
});

describe('données de démo : objectifs de force et plateau', () => {
  it('montre un plateau au développé militaire, pas sur les exercices qui progressent', async () => {
    const { detectPlateau } = await import('@kinetic/core');
    const { sessions } = buildDemoData(NOW);
    const now = NOW.getTime();
    const plateau = detectPlateau(sessions, 'ohp', { now, incrementKg: 1.25 });
    expect(plateau?.sessions).toBeGreaterThanOrEqual(4);
    for (const id of ['bp', 'sq', 'dl', 'row'])
      expect(detectPlateau(sessions, id, { now })).toBeNull();
  });

  it('objectifs : un en route avec date, un sur tendance plate, un atteint', async () => {
    const { evaluateGoal, normalizeGoals } = await import('@kinetic/core');
    const { sessions, values } = buildDemoData(NOW);
    const goals = normalizeGoals(values.find(([k]) => k === 'kinetic:goals:strength')?.[1]);
    expect(goals).toHaveLength(4);
    const states = Object.fromEntries(
      goals.map((g) => [g.exerciseId, evaluateGoal(g, sessions, NOW.getTime()).state]),
    );
    expect(states['sq']).toBe('on-track');
    expect(states['ohp']).toBe('flat');
    expect(states['dl']).toBe('achieved');
  });
});

describe('données de démo : poids actuel', () => {
  // Constat iOS (9.17.0) : « Poids actuel 63,2 kg » sur une installation, 77,6 kg sur les
  // autres. La démo n'en est pas la cause : à heure, jour ou date de lancement quelconques,
  // le poids actuel est la dernière pesée de l'historique, dans la plage de la démo.
  const launches = [
    NOW,
    new Date(2026, 10, 28, 0, 5),
    new Date(2026, 10, 28, 23, 55),
    new Date(2026, 9, 3, 7, 30),
    new Date(2027, 0, 1, 12, 0),
  ];
  it.each(launches)('lancement %s : poids actuel = dernière pesée de l’historique', async (at) => {
    const { currentBodyweightKg, sortByDate, STORAGE_KEYS } = await import('@kinetic/core');
    const { values } = buildDemoData(at);
    const entries = values.find(([k]) => k === STORAGE_KEYS.BODYWEIGHT_ENTRIES)?.[1] as Array<{
      date: string;
      weight: number;
    }>;
    const dates = entries.map((e) => e.date);
    expect(new Set(dates).size).toBe(dates.length); // une pesée par jour
    expect(sortByDate(entries)).toEqual(entries); // déjà triées
    const history = sortByDate(entries);
    expect(currentBodyweightKg(entries)).toBe(history.at(-1)!.weight);
    for (const e of entries) {
      expect(e.weight).toBeGreaterThan(76.5);
      expect(e.weight).toBeLessThan(80.5);
    }
    const profile = values.find(([k]) => k === STORAGE_KEYS.USER_PROFILE)?.[1] as {
      weightKg: number;
    };
    expect(profile.weightKg).toBe(history.at(-1)!.weight);
  });
});
