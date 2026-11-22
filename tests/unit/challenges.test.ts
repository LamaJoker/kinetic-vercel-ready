import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
vi.mock('../../apps/web/src/lib/training/storage.js', () => ({
  loadSessions: vi.fn(),
  loadExercises: vi.fn(),
}));

import { STORAGE_KEYS } from '@kinetic/core';
import { getDeps } from '../../apps/web/src/deps.js';
import { loadExercises, loadSessions } from '../../apps/web/src/lib/training/storage.js';
import {
  acceptChallenge,
  createChallenge,
  dropChallenge,
  refreshChallenges,
} from '../../apps/web/src/lib/challenges';
import {
  CUSTOM_METRICS,
  challengeRingStyle,
  challengeTone,
  sortProgress,
} from '../../apps/web/src/components/challenges';
import {
  asCelebration,
  challengeCelebration,
  setCelebrationsMuted,
} from '../../apps/web/src/lib/celebration';
import { recapChartGeometry, shortDay } from '../../apps/web/src/pages/bilan.page';
import {
  InMemoryStorage,
  SpyNotifier,
  FakeClock,
  SequentialIdGenerator,
} from '../helpers/stubs.js';

const events: Array<{ type: string; detail: unknown }> = [];

function session(day: number, hour = 18) {
  return {
    id: `s${day}`,
    name: 'Séance',
    startedAt: new Date(2026, 10, day, hour).toISOString(),
    durationMin: 60,
    entries: [
      {
        exerciseId: 'pullup',
        sets: [{ setIndex: 0, reps: 10, weightKg: 0, rpe: 8, performedAt: '' }],
      },
    ],
  };
}

let storage: InMemoryStorage;

beforeEach(() => {
  events.length = 0;
  storage = new InMemoryStorage();
  vi.mocked(getDeps).mockResolvedValue({
    storage,
    clock: new FakeClock('2026-11-22'),
    idGen: new SequentialIdGenerator(),
    notifier: new SpyNotifier(),
  } as never);
  vi.mocked(loadExercises).mockResolvedValue([
    { id: 'pullup', name: 'Tractions', muscles: ['back'], equipment: 'bodyweight', incrementKg: 0 },
  ]);
  vi.stubGlobal('window', {
    dispatchEvent: (e: { type: string; detail?: unknown }) => {
      events.push({ type: e.type, detail: e.detail });
      return true;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal(
    'CustomEvent',
    class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  );
  setCelebrationsMuted(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshChallenges : récompense une seule fois', () => {
  it('défi réussi → enregistré, +XP et célébration ; pas deux fois', async () => {
    // 2 séances cette semaine : le défi automatique « 2 séances » (débutant) est réussi.
    vi.mocked(loadSessions).mockResolvedValue([session(16), session(18)] as never);
    const now = new Date(2026, 10, 22, 12);
    const snap = await refreshChallenges(now);
    const week = snap.progress.find((p) => p.def.period === 'week')!;
    expect(week.state).toBe('done');
    expect(snap.completed.map((c) => c.id)).toContain(week.def.id);
    const xp = await storage.get<{ xp: number }>(STORAGE_KEYS.XP);
    expect(xp?.xp).toBe(25);
    expect(events.filter((e) => e.type === STORAGE_KEYS.EVENT_CELEBRATE)).toHaveLength(1);

    // Deux évaluations simultanées ensuite : rien de plus.
    await Promise.all([refreshChallenges(now), refreshChallenges(now)]);
    expect((await storage.get<{ xp: number }>(STORAGE_KEYS.XP))?.xp).toBe(25);
    expect(events.filter((e) => e.type === STORAGE_KEYS.EVENT_CELEBRATE)).toHaveLength(1);
  });

  it('accepter, créer puis abandonner un défi', async () => {
    vi.mocked(loadSessions).mockResolvedValue([] as never);
    const now = new Date(2026, 10, 22, 12);
    const snap = await refreshChallenges(now);
    const sugg = snap.suggestions[0]!;
    await acceptChallenge(sugg);
    await acceptChallenge(sugg); // sans doublon
    let after = await refreshChallenges(now);
    expect(after.progress.filter((p) => p.def.id === sugg.id)).toHaveLength(1);
    expect(after.suggestions.some((d) => d.id === sugg.id)).toBe(false);

    expect(await createChallenge({ metric: 'sessions', period: 'week', target: 99 }, now)).toMatch(
      /Choisis une cible/,
    );
    expect(await createChallenge({ metric: 'sessions', period: 'week', target: 4 }, now)).toBe('');
    after = await refreshChallenges(now);
    const custom = after.progress.find((p) => p.def.origin === 'custom')!;
    expect(custom.xp).toBe(10);
    await dropChallenge(custom.def.id);
    after = await refreshChallenges(now);
    expect(after.progress.some((p) => p.def.origin === 'custom')).toBe(false);
  });
});

describe('affichage des défis', () => {
  it('anneau, couleur et ordre', () => {
    expect(challengeRingStyle({ ratio: 0.456 })).toBe('--p: 46');
    expect(challengeRingStyle({ ratio: 3 })).toBe('--p: 100');
    expect(challengeTone({ state: 'done' })).toBe('text-kinetic-teal');
    const list = [
      { state: 'done', ratio: 1 },
      { state: 'active', ratio: 0.2 },
      { state: 'failed', ratio: 0.9 },
      { state: 'active', ratio: 0.7 },
    ] as never[];
    expect(sortProgress(list).map((p: { state: string; ratio: number }) => p.ratio)).toEqual([
      0.7, 0.2, 1, 0.9,
    ]);
    expect(new Set(CUSTOM_METRICS.map((m) => m.key)).size).toBe(7);
  });

  it('célébration de défi : médaille emoji, validée à la réception', () => {
    const d = challengeCelebration('12 séances ce mois-ci', '🏋️', 50);
    expect(d).toEqual({
      kind: 'challenge',
      title: 'Défi réussi !',
      subtitle: '12 séances ce mois-ci · +50 XP',
      badge: '🏋️',
    });
    expect(asCelebration(d)).toEqual(d);
  });
});

describe('page Bilan : courbe', () => {
  it('géométrie dans le cadre, du plus bas au plus haut', () => {
    const g = recapChartGeometry([100, 110, 105]);
    expect(g.coords).toHaveLength(3);
    expect(g.coords[0]![1]).toBe(g.bottom);
    expect(g.coords[1]![1]).toBe(g.top);
    expect(g.coords[2]![0]).toBe(g.W - 12);
    const flat = recapChartGeometry([80, 80]);
    expect(flat.coords.every(([, y]) => Number.isFinite(y))).toBe(true);
    expect(shortDay('2026-11-03')).toBe('3 nov.');
  });
});

describe('démo : défis', () => {
  it('médailles déjà gagnées et défis réussis de la période enregistrés (pas de rafale)', async () => {
    const { buildDemoData } = await import('../../apps/web/src/lib/demo');
    const { activeDefs, evaluateChallenge, normalizeChallengeStore } =
      await import('@kinetic/core');
    const now = new Date(2026, 10, 22, 12);
    const { sessions, values } = buildDemoData(now);
    const raw = values.find(([k]) => k === STORAGE_KEYS.CHALLENGES)?.[1];
    const store = normalizeChallengeStore(raw);
    expect(store.completed.length).toBeGreaterThan(2);
    expect(store.accepted.map((d) => d.metric)).toEqual(['checkinStreak']);
    for (const c of store.completed)
      expect(Date.parse(c.completedAt)).toBeLessThanOrEqual(now.getTime());
    const checkins = values.find(([k]) => k === STORAGE_KEYS.WELLNESS_CHECKINS)?.[1] as object;
    const data = { sessions, checkinDays: Object.keys(checkins) };
    const done = activeDefs({ data, now, nameOf: (id) => id }, store)
      .map((d) => evaluateChallenge(d, data, now))
      .filter((p) => p.state === 'done');
    for (const p of done) expect(store.completed.some((c) => c.id === p.def.id)).toBe(true);
  });
});
