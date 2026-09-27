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
});
