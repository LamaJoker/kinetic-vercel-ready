import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

const { storage } = vi.hoisted(() => ({ storage: { current: null as unknown } }));

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(async () => ({ storage: storage.current })),
}));
vi.mock('../../apps/web/src/lib/haptics.js', () => ({
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
}));
vi.mock('alpinejs', () => ({ default: { store: vi.fn(() => undefined) } }));

import { runShortcutAction } from '../../apps/web/src/lib/shortcut-actions.js';

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('runShortcutAction', () => {
  let store: InMemoryStorage;
  let messages: Array<{ kind: string; message: string }>;
  let session: Map<string, string>;

  beforeEach(() => {
    store = new InMemoryStorage();
    storage.current = store;
    messages = [];
    session = new Map();
    const target = new EventTarget();
    target.addEventListener(STORAGE_KEYS.EVENT_NOTIFY, (e) => {
      messages.push((e as CustomEvent).detail);
    });
    vi.stubGlobal(
      'window',
      Object.assign(target, {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (id: number) => clearTimeout(id),
      }),
    );
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ajoute un verre, ouvre l’accueil et confirme', async () => {
    const today = localDay(new Date());
    await store.set(STORAGE_KEYS.WELLNESS_WATER, { [today]: [250, 250] });
    await store.set(STORAGE_KEYS.WELLNESS_WATER_PREFS, { glassMl: 250, goalMl: 2000 });
    const open = vi.fn();
    await runShortcutAction('add-water', open);
    expect(await store.get(STORAGE_KEYS.WELLNESS_WATER)).toEqual({ [today]: [250, 250, 250] });
    expect(open).toHaveBeenCalledWith('/');
    expect(messages).toEqual([
      { kind: 'success', message: 'Verre ajouté (250 ml) : 750 ml sur 2 L aujourd’hui.' },
    ]);
  });

  it("signale l'objectif atteint", async () => {
    const today = localDay(new Date());
    await store.set(STORAGE_KEYS.WELLNESS_WATER, { [today]: [500, 500, 500] });
    await store.set(STORAGE_KEYS.WELLNESS_WATER_PREFS, { glassMl: 500, goalMl: 2000 });
    await runShortcutAction('add-water', vi.fn());
    expect(messages[0]?.message).toContain('objectif atteint');
  });

  it('prépare la séance proposée et ouvre Séances', async () => {
    const open = vi.fn();
    await runShortcutAction('start-today', open);
    expect(open).toHaveBeenCalledWith('/seances');
    // Modèles par défaut créés au premier chargement : le premier est proposé.
    expect(session.get(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE)).toBeTruthy();
  });

  it('reprend la séance en cours sans en préparer une autre', async () => {
    await store.set(STORAGE_KEYS.TRAINING_ACTIVE_SESSION, {
      v: 1,
      session: { id: 's1', name: 'Push', startedAt: new Date().toISOString(), entries: [] },
      restEndsAtMs: 0,
      restTotalSec: 90,
      restPresetSec: 90,
      activeExerciseId: null,
      savedAtMs: Date.now(),
    });
    const open = vi.fn();
    await runShortcutAction('start-today', open);
    expect(open).toHaveBeenCalledWith('/seances');
    expect(session.has(STORAGE_KEYS.PROGRAM_AUTO_TEMPLATE)).toBe(false);
  });

  it('ouvre la pesée et le check-in', async () => {
    const open = vi.fn();
    vi.stubGlobal('document', { querySelector: () => null });
    await runShortcutAction('log-weight', open);
    await runShortcutAction('checkin', open);
    expect(open.mock.calls).toEqual([['/bodyweight'], ['/']]);
  });
});
