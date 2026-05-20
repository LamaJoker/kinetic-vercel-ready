import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(),
}));

import { getDeps } from '../../apps/web/src/deps.js';
import { vitaliteStore } from '../../apps/web/src/stores/vitalite.js';
import {
  InMemoryStorage,
  FakeClock,
  SequentialIdGenerator,
  SpyNotifier,
} from '../helpers/stubs.js';

function makeMockDeps(overrides: Partial<{ storage: unknown; clock: unknown }> = {}) {
  const storage = new InMemoryStorage();
  return {
    storage: overrides.storage ?? storage,
    clock: overrides.clock ?? new FakeClock('2026-05-12'),
    idGen: new SequentialIdGenerator(),
    notifier: new SpyNotifier(),
  };
}

describe('vitaliteStore initial state', () => {
  it('starts with correct defaults', () => {
    const store = vitaliteStore();
    expect(store.tasks).toHaveLength(0);
    expect(store.loading).toBe(true);
    expect(store.completingId).toBeNull();
    expect(store.showAddForm).toBe(false);
    expect(store.showHistory).toBe(false);
    expect(store.newTaskTitle).toBe('');
    expect(store.newTaskXp).toBe(40);
    expect(store.newTaskPriority).toBe('med');
    expect(Array.isArray(store.emojiSuggestions)).toBe(true);
    expect(store.emojiSuggestions.length).toBeGreaterThan(10);
  });
});

describe('vitaliteStore.init', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
  });

  afterEach(() => vi.clearAllMocks());

  it('loads default tasks when storage is empty', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.loading).toBe(false);
    expect(store.tasks.length).toBeGreaterThan(0); // DEFAULT_TASKS_SPEC items
  });

  it('marks tasks as done based on stored done-IDs', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await storage.set(`kinetic:vitalite:done:${today}`, ['morning-stretch', 'cold-shower']);
    const store = vitaliteStore();
    await store.init();
    const stretch = store.tasks.find((t) => t.id === 'morning-stretch');
    const shower = store.tasks.find((t) => t.id === 'cold-shower');
    expect(stretch?.done).toBe(true);
    expect(shower?.done).toBe(true);
  });

  it('handles init failure gracefully', async () => {
    vi.mocked(getDeps).mockRejectedValue(new Error('IDB unavailable'));
    const store = vitaliteStore();
    await store.init();
    expect(store.loading).toBe(false);
    expect(store.tasks.length).toBeGreaterThan(0); // fallback to defaults
  });

  it('loads custom tasks from storage', async () => {
    const customSpecs = [
      { id: 'custom-1', title: 'Custom Task', icon: '🎯', xp: 60, priority: 'high' as const },
    ];
    await storage.set('kinetic:vitalite:custom-tasks', customSpecs);
    const store = vitaliteStore();
    await store.init();
    const custom = store.tasks.find((t) => t.id === 'custom-1');
    expect(custom).toBeDefined();
    expect(custom?.title).toBe('Custom Task');
  });
});

describe('vitaliteStore.complete', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
  });

  afterEach(() => vi.clearAllMocks());

  it('ignores already-done tasks', async () => {
    const store = vitaliteStore();
    await store.init();
    const task = store.tasks.find((t) => !t.done);
    if (!task) return; // skip if no undone task (unlikely)
    // Manually mark as done
    store.tasks = store.tasks.map((t) => (t.id === task.id ? { ...t, done: true } : t));
    const getSpy = vi.spyOn(storage, 'set');
    await store.complete(task.id);
    // Should early-return without calling storage.set for the task completion
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('ignores non-existent task IDs', async () => {
    const store = vitaliteStore();
    await store.init();
    const setSpy = vi.spyOn(storage, 'set');
    await store.complete('non-existent-id');
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('vitaliteStore.undo', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
  });

  afterEach(() => vi.clearAllMocks());

  it('ignores undo on non-done tasks', async () => {
    const store = vitaliteStore();
    await store.init();
    const task = store.tasks.find((t) => !t.done);
    if (!task) return;
    const setSpy = vi.spyOn(storage, 'set');
    await store.undo(task.id);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('vitaliteStore computed getters', () => {
  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps() as any);
  });

  afterEach(() => vi.clearAllMocks());

  it('doneCount returns number of completed tasks', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.doneCount).toBe(0);
  });

  it('totalCount returns total task count', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.totalCount).toBeGreaterThan(0);
  });

  it('progress returns 0 when nothing done', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.progress).toBe(0);
  });

  it('allDone is false when nothing done', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.allDone).toBe(false);
  });

  it('allDone is true when all tasks done', async () => {
    const store = vitaliteStore();
    await store.init();
    store.tasks = store.tasks.map((t) => ({ ...t, done: true }));
    expect(store.allDone).toBe(true);
  });

  it('isLocked returns false for tasks not in _pendingIds', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.isLocked('any-id')).toBe(false);
  });

  it('isLocked returns true for tasks in _pendingIds', async () => {
    const store = vitaliteStore();
    store._pendingIds = ['locked-task'];
    expect(store.isLocked('locked-task')).toBe(true);
  });

  it('isCustom returns false for default tasks', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.isCustom('morning-stretch')).toBe(false);
  });

  it('destroy clears pending state', async () => {
    const store = vitaliteStore();
    store._pendingIds = ['task-1', 'task-2'];
    store.completingId = 'task-1';
    store.destroy();
    expect(store._pendingIds).toHaveLength(0);
    expect(store.completingId).toBeNull();
  });
});

describe('vitaliteStore.hideTask / unhideTask', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
  });

  afterEach(() => vi.clearAllMocks());

  it('hideTask removes a default task from the active list and persists hiddenIds', async () => {
    const store = vitaliteStore();
    await store.init();
    const initialCount = store.tasks.length;
    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(true);

    await store.hideTask('morning-stretch');

    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(false);
    expect(store.tasks.length).toBe(initialCount - 1);
    expect(store.hiddenIds).toContain('morning-stretch');
    const persisted = await storage.get<string[]>('kinetic:vitalite:hiddenIds');
    expect(persisted).toEqual(['morning-stretch']);
  });

  it('hideTask refuses to hide a custom task (use deleteCustomTask instead)', async () => {
    const customSpecs = [
      { id: 'custom-1', title: 'My task', icon: '🎯', xp: 60, priority: 'high' as const },
    ];
    await storage.set('kinetic:vitalite:custom-tasks', customSpecs);
    const store = vitaliteStore();
    await store.init();
    expect(store.tasks.some((t) => t.id === 'custom-1')).toBe(true);

    await store.hideTask('custom-1');

    // Custom tâche reste visible, hiddenIds inchangé
    expect(store.tasks.some((t) => t.id === 'custom-1')).toBe(true);
    expect(store.hiddenIds).not.toContain('custom-1');
  });

  it('hideTask is idempotent (hiding twice is a no-op)', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.hideTask('morning-stretch');
    await store.hideTask('morning-stretch');
    expect(store.hiddenIds.filter((id) => id === 'morning-stretch')).toHaveLength(1);
  });

  it('init() filters out previously hidden default tasks', async () => {
    await storage.set('kinetic:vitalite:hiddenIds', ['morning-stretch', 'cold-shower']);
    const store = vitaliteStore();
    await store.init();
    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(false);
    expect(store.tasks.some((t) => t.id === 'cold-shower')).toBe(false);
    expect(store.hiddenIds).toEqual(['morning-stretch', 'cold-shower']);
  });

  it('unhideTask restores a previously hidden task and persists', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.hideTask('morning-stretch');
    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(false);

    await store.unhideTask('morning-stretch');

    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(true);
    expect(store.hiddenIds).not.toContain('morning-stretch');
    const persisted = await storage.get<string[]>('kinetic:vitalite:hiddenIds');
    expect(persisted).toEqual([]);
  });

  it('unhideTask preserves the done state of the restored task', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await storage.set(`kinetic:vitalite:done:${today}`, ['morning-stretch']);
    const store = vitaliteStore();
    await store.init();
    // Tâche cochée, on la masque puis on la restaure
    await store.hideTask('morning-stretch');
    await store.unhideTask('morning-stretch');
    const restored = store.tasks.find((t) => t.id === 'morning-stretch');
    expect(restored?.done).toBe(true);
  });

  it('unhideTask is a no-op when the task is not hidden', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.unhideTask('morning-stretch'); // pas masquée
    expect(store.hiddenIds).toHaveLength(0);
    expect(store.tasks.some((t) => t.id === 'morning-stretch')).toBe(true);
  });

  it('hiddenSpecsList contains full specs of currently hidden default tasks', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.hideTask('morning-stretch');
    await store.hideTask('cold-shower');
    const specs = store.hiddenSpecsList;
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.id).sort()).toEqual(['cold-shower', 'morning-stretch']);
    expect(specs.find((s) => s.id === 'morning-stretch')?.icon).toBe('🧘');
    expect(specs.find((s) => s.id === 'morning-stretch')?.xp).toBeGreaterThan(0);
  });

  it('hiddenSpecsList shrinks when a task is unhidden', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.hideTask('morning-stretch');
    await store.hideTask('cold-shower');
    expect(store.hiddenSpecsList).toHaveLength(2);
    await store.unhideTask('morning-stretch');
    expect(store.hiddenSpecsList).toHaveLength(1);
    expect(store.hiddenSpecsList[0]?.id).toBe('cold-shower');
  });
});

describe('vitaliteStore.complete (success path)', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), Alpine: undefined });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('marks the task done and persists the done-ID', async () => {
    const store = vitaliteStore();
    await store.init();
    const task = store.tasks.find((t) => !t.done);
    if (!task) throw new Error('no undone task found');

    await store.complete(task.id);

    const updated = store.tasks.find((t) => t.id === task.id);
    expect(updated?.done).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const doneIds = await storage.get<string[]>(`kinetic:vitalite:done:${today}`);
    expect(doneIds).toContain(task.id);
  });

  it('is idempotent when completing an already-pending task', async () => {
    const store = vitaliteStore();
    await store.init();
    const task = store.tasks.find((t) => !t.done);
    if (!task) throw new Error('no undone task found');

    store._pendingIds = [task.id];
    const setSpy = vi.spyOn(storage, 'set');
    await store.complete(task.id);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('vitaliteStore.undo (success path)', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), Alpine: undefined });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('unmarks a completed task and updates state', async () => {
    const store = vitaliteStore();
    await store.init();

    const task = store.tasks.find((t) => !t.done);
    if (!task) throw new Error('no undone task found');

    await store.complete(task.id);
    expect(store.tasks.find((t) => t.id === task.id)?.done).toBe(true);

    await store.undo(task.id);
    expect(store.tasks.find((t) => t.id === task.id)?.done).toBe(false);
  });
});

describe('vitaliteStore.addCustomTask', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds a new custom task and persists it', async () => {
    const store = vitaliteStore();
    await store.init();
    const initialCount = store.tasks.length;

    store.newTaskTitle = 'Read every day';
    store.newTaskIcon = '📖';
    store.newTaskXp = 60;
    store.newTaskPriority = 'high';

    await store.addCustomTask();

    expect(store.tasks.length).toBe(initialCount + 1);
    expect(store.tasks.some((t) => t.title === 'Read every day')).toBe(true);
    expect(store.showAddForm).toBe(false);
    expect(store.newTaskTitle).toBe('');

    const persisted = await storage.get<unknown[]>('kinetic:vitalite:custom-tasks');
    expect(Array.isArray(persisted)).toBe(true);
    expect((persisted as any[]).some((s: any) => s.title === 'Read every day')).toBe(true);
  });

  it('sets addFormError when title is empty', async () => {
    const store = vitaliteStore();
    await store.init();

    store.newTaskTitle = '';
    await store.addCustomTask();

    expect(store.addFormError).toBeTruthy();
    expect(store.tasks.some((t) => t.title === '')).toBe(false);
  });

  it('resets the form after successful add', async () => {
    const store = vitaliteStore();
    await store.init();

    store.newTaskTitle = 'My task';
    store.newTaskIcon = '🎯';
    store.newTaskXp = 80;
    store.newTaskPriority = 'low';
    store.showAddForm = true;

    await store.addCustomTask();

    expect(store.newTaskTitle).toBe('');
    expect(store.newTaskIcon).toBe('⭐');
    expect(store.newTaskXp).toBe(40);
    expect(store.newTaskPriority).toBe('med');
    expect(store.showAddForm).toBe(false);
  });
});

describe('vitaliteStore.deleteCustomTask', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('removes a custom task from state and storage', async () => {
    const customSpecs = [
      { id: 'custom-1', title: 'My task', icon: '🎯', xp: 60, priority: 'high' as const },
    ];
    await storage.set('kinetic:vitalite:custom-tasks', customSpecs);

    const store = vitaliteStore();
    await store.init();
    expect(store.tasks.some((t) => t.id === 'custom-1')).toBe(true);

    await store.deleteCustomTask('custom-1');

    expect(store.tasks.some((t) => t.id === 'custom-1')).toBe(false);
    expect(store.customSpecs.some((s) => s.id === 'custom-1')).toBe(false);

    const persisted = await storage.get<unknown[]>('kinetic:vitalite:custom-tasks');
    expect((persisted as any[]).some((s: any) => s.id === 'custom-1')).toBe(false);
  });

  it('is a no-op when task ID is currently pending', async () => {
    const store = vitaliteStore();
    await store.init();
    store._pendingIds = ['custom-1'];
    const setSpy = vi.spyOn(storage, 'set');
    await store.deleteCustomTask('custom-1');
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('vitaliteStore.loadHistory / toggleHistory', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps({ storage }) as any);
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      Alpine: { store: () => ({ historyDays: 7 }) },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loadHistory populates historyDays with the last 7 days', async () => {
    const store = vitaliteStore();
    await store.init();
    await store.loadHistory();

    expect(store.historyDays.length).toBeGreaterThan(0);
    expect(store.historyLoading).toBe(false);
    expect(store.historyDays[0]).toHaveProperty('date');
    expect(store.historyDays[0]).toHaveProperty('doneIds');
  });

  it('loadHistory is idempotent when historyLoading is already true', async () => {
    const store = vitaliteStore();
    await store.init();
    store.historyLoading = true;
    const getSpy = vi.spyOn(storage, 'get');
    await store.loadHistory();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('toggleHistory sets showHistory and loads when first opened', async () => {
    const store = vitaliteStore();
    await store.init();
    expect(store.showHistory).toBe(false);

    await store.toggleHistory();

    expect(store.showHistory).toBe(true);
    expect(store.historyDays.length).toBeGreaterThan(0);
  });

  it('toggleHistory hides panel on second call without reloading', async () => {
    const store = vitaliteStore();
    await store.init();

    await store.toggleHistory(); // open + load
    const loadedDays = store.historyDays.length;

    await store.toggleHistory(); // close
    expect(store.showHistory).toBe(false);
    expect(store.historyDays.length).toBe(loadedDays); // unchanged
  });
});

describe('vitaliteStore._hasXpBonus / _rewardsHistoryDays', () => {
  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue(makeMockDeps() as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('_hasXpBonus returns false when Alpine is not available', () => {
    vi.stubGlobal('window', {});
    const store = vitaliteStore();
    expect(store._hasXpBonus()).toBe(false);
  });

  it('_hasXpBonus returns false when xp level < 5', () => {
    vi.stubGlobal('window', {
      Alpine: { store: () => ({ currentLevel: 3 }) },
    });
    const store = vitaliteStore();
    expect(store._hasXpBonus()).toBe(false);
  });

  it('_hasXpBonus returns true when xp level >= 5', () => {
    vi.stubGlobal('window', {
      Alpine: { store: () => ({ currentLevel: 5 }) },
    });
    const store = vitaliteStore();
    expect(store._hasXpBonus()).toBe(true);
  });

  it('_rewardsHistoryDays returns the rewards store historyDays value', () => {
    vi.stubGlobal('window', {
      Alpine: { store: () => ({ historyDays: 30 }) },
    });
    const store = vitaliteStore();
    expect(store._rewardsHistoryDays()).toBe(30);
  });

  it('_rewardsHistoryDays returns 7 as fallback when Alpine is unavailable', () => {
    vi.stubGlobal('window', {});
    const store = vitaliteStore();
    expect(store._rewardsHistoryDays()).toBe(7);
  });
});
