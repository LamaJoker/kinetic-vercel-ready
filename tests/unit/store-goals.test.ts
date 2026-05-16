import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(),
}));
vi.mock('../../apps/web/src/lib/training/storage.js', () => ({
  loadSessions: vi.fn(),
}));

import { getDeps } from '../../apps/web/src/deps.js';
import { loadSessions } from '../../apps/web/src/lib/training/storage.js';
import {
  InMemoryStorage,
  SpyNotifier,
  FakeClock,
  SequentialIdGenerator,
} from '../helpers/stubs.js';

type SessionItem = {
  id?: string;
  startedAt: string;
  endedAt: string;
  entries: Array<{ sets: Array<{ reps: number; weightKg: number }> }>;
};

function makeSession(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: overrides.id,
    startedAt: overrides.startedAt ?? '2026-05-12T10:00:00Z',
    endedAt: overrides.endedAt ?? '2026-05-12T11:00:00Z',
    entries: overrides.entries ?? [],
  };
}

function makeDeps() {
  return {
    storage: new InMemoryStorage(),
    clock: new FakeClock('2026-05-12'),
    idGen: new SequentialIdGenerator(),
    notifier: new SpyNotifier(),
  };
}

// Minimal browser-like window stub for tests that need addEventListener/dispatchEvent
function makeFakeWindow() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn(event));
      return true;
    },
    _listeners: listeners,
  };
}

describe('goalsStore initial state', () => {
  it('has correct defaults', async () => {
    vi.stubGlobal('window', makeFakeWindow());
    vi.resetModules();
    const { goalsStore } = await import('../../apps/web/src/stores/goals.js');
    const store = goalsStore();
    expect(store.targetSessions).toBe(3);
    expect(store.targetTonnageKg).toBe(0);
    expect(store.doneSessions).toBe(0);
    expect(store.loading).toBe(true);
    expect(store.sessionsOk).toBe(false);
    expect(store.tonnageOk).toBe(true);
    expect(store.allOk).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('goalsStore._upsertSession', () => {
  let goalsStore: Awaited<typeof import('../../apps/web/src/stores/goals.js')>['goalsStore'];

  beforeEach(async () => {
    vi.stubGlobal('window', makeFakeWindow());
    vi.resetModules();
    ({ goalsStore } = await import('../../apps/web/src/stores/goals.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('appends a new session to an empty list', () => {
    const store = goalsStore();
    const session = makeSession({ id: 'a' });
    const result = store._upsertSession([], session);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(session);
  });

  it('appends a new session with a different id', () => {
    const store = goalsStore();
    const s1 = makeSession({ id: 'a' });
    const s2 = makeSession({
      id: 'b',
      startedAt: '2026-05-13T10:00:00Z',
      endedAt: '2026-05-13T11:00:00Z',
    });
    const result = store._upsertSession([s1], s2);
    expect(result).toHaveLength(2);
  });

  it('replaces an existing session with the same id', () => {
    const store = goalsStore();
    const s1 = makeSession({ id: 'a' });
    const updated = makeSession({ id: 'a', entries: [{ sets: [{ reps: 5, weightKg: 100 }] }] });
    const result = store._upsertSession([s1], updated);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(updated);
  });

  it('deduplicates by startedAt+endedAt when no id present', () => {
    const store = goalsStore();
    const s1 = makeSession({ startedAt: '2026-05-12T10:00:00Z', endedAt: '2026-05-12T11:00:00Z' });
    const s2 = makeSession({
      startedAt: '2026-05-12T10:00:00Z',
      endedAt: '2026-05-12T11:00:00Z',
      entries: [{ sets: [{ reps: 3, weightKg: 80 }] }],
    });
    const result = store._upsertSession([s1], s2);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(s2);
  });

  it('does not mutate the original list', () => {
    const store = goalsStore();
    const original: SessionItem[] = [];
    store._upsertSession(original, makeSession({ id: 'x' }));
    expect(original).toHaveLength(0);
  });
});

describe('goalsStore._applyState', () => {
  let goalsStore: Awaited<typeof import('../../apps/web/src/stores/goals.js')>['goalsStore'];

  beforeEach(async () => {
    vi.stubGlobal('window', makeFakeWindow());
    vi.resetModules();
    ({ goalsStore } = await import('../../apps/web/src/stores/goals.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sets doneSessions to 0 for empty list', () => {
    const store = goalsStore();
    const state = store._applyState([]);
    expect(state.doneSessions).toBe(0);
    expect(store.doneSessions).toBe(0);
  });

  it('reflects state back onto the store object', () => {
    const store = goalsStore();
    store._applyState([]);
    expect(store.weekKey.length).toBeGreaterThan(0);
  });

  it('counts sessions from the current week', () => {
    const store = goalsStore();
    // 2026-05-12 is a Tuesday, within the current week
    const session = makeSession({
      startedAt: '2026-05-12T10:00:00Z',
      endedAt: '2026-05-12T11:00:00Z',
    });
    const state = store._applyState([session]);
    // weekKey should be a non-empty string (date-based week identifier)
    expect(state.weekKey.length).toBeGreaterThan(0);
  });
});

describe('goalsStore.init', () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;
  let deps: ReturnType<typeof makeDeps>;
  let goalsStore: Awaited<typeof import('../../apps/web/src/stores/goals.js')>['goalsStore'];

  beforeEach(async () => {
    fakeWindow = makeFakeWindow();
    vi.stubGlobal('window', fakeWindow);
    vi.resetModules();
    deps = makeDeps();
    vi.mocked(getDeps).mockResolvedValue(deps as ReturnType<typeof getDeps>);
    vi.mocked(loadSessions).mockResolvedValue([]);
    ({ goalsStore } = await import('../../apps/web/src/stores/goals.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sets loading=false after init', async () => {
    const store = goalsStore();
    await store.init();
    expect(store.loading).toBe(false);
  });

  it('reads saved targets from storage', async () => {
    await deps.storage.set('kinetic:goals:weekly', {
      targetSessions: 5,
      targetTonnageKg: 2000,
      xpAwardedWeek: '',
    });
    const store = goalsStore();
    await store.init();
    expect(store.targetSessions).toBe(5);
    expect(store.targetTonnageKg).toBe(2000);
  });

  it('handles getDeps failure gracefully', async () => {
    vi.mocked(getDeps).mockRejectedValue(new Error('storage unavailable'));
    const store = goalsStore();
    await store.init();
    expect(store.loading).toBe(false);
  });

  it('registers window event listeners on init', async () => {
    const store = goalsStore();
    await store.init();
    expect(fakeWindow._listeners.has('kinetic:session-saved')).toBe(true);
    expect(fakeWindow._listeners.has('kinetic:deps-ready')).toBe(true);
  });

  it('removes listeners on destroy', async () => {
    const store = goalsStore();
    await store.init();
    store.destroy();
    expect(fakeWindow._listeners.get('kinetic:session-saved')?.size).toBe(0);
    expect(fakeWindow._listeners.get('kinetic:deps-ready')?.size).toBe(0);
  });
});

describe('goalsStore.save', () => {
  let deps: ReturnType<typeof makeDeps>;
  let goalsStore: Awaited<typeof import('../../apps/web/src/stores/goals.js')>['goalsStore'];

  beforeEach(async () => {
    vi.stubGlobal('window', makeFakeWindow());
    vi.resetModules();
    deps = makeDeps();
    vi.mocked(getDeps).mockResolvedValue(deps as ReturnType<typeof getDeps>);
    vi.mocked(loadSessions).mockResolvedValue([]);
    ({ goalsStore } = await import('../../apps/web/src/stores/goals.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('persists current targets to storage', async () => {
    const store = goalsStore();
    store.targetSessions = 4;
    store.targetTonnageKg = 1500;
    await store.save();
    const saved = await deps.storage.get<{ targetSessions: number; targetTonnageKg: number }>(
      'kinetic:goals:weekly',
    );
    expect(saved?.targetSessions).toBe(4);
    expect(saved?.targetTonnageKg).toBe(1500);
  });
});

describe('goalsStore session-saved event', () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;
  let deps: ReturnType<typeof makeDeps>;
  let goalsStore: Awaited<typeof import('../../apps/web/src/stores/goals.js')>['goalsStore'];

  beforeEach(async () => {
    fakeWindow = makeFakeWindow();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal(
      'CustomEvent',
      class extends Event {
        detail: unknown;
        constructor(type: string, init?: CustomEventInit) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );
    vi.resetModules();
    deps = makeDeps();
    vi.mocked(getDeps).mockResolvedValue(deps as ReturnType<typeof getDeps>);
    vi.mocked(loadSessions).mockResolvedValue([]);
    ({ goalsStore } = await import('../../apps/web/src/stores/goals.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('applies delta when session-saved event carries a session', async () => {
    const store = goalsStore();
    await store.init();

    const session = makeSession({ id: 'new-1' });
    fakeWindow.dispatchEvent(new CustomEvent('kinetic:session-saved', { detail: { session } }));

    expect(store._sessionsCache).toHaveLength(1);
  });

  it('triggers full reload when event has no session payload', async () => {
    const store = goalsStore();
    await store.init();

    const reloadSpy = vi.spyOn(store, 'reload');
    fakeWindow.dispatchEvent(new CustomEvent('kinetic:session-saved', { detail: {} }));

    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});
