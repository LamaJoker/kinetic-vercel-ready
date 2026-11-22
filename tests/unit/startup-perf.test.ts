/**
 * Démarrage plus rapide : travail différé après le premier écran, lectures de
 * séances regroupées, gabarit de page téléchargé une seule fois.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  afterFirstRender,
  _setFirstRenderDoneForTesting,
} from '../../apps/web/src/lib/performance.js';
import { loadSessions, saveSession } from '../../apps/web/src/lib/training/storage.js';
import { pageTemplate } from '../../apps/web/src/lib/page-template.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('afterFirstRender', () => {
  it('attend le premier écran, puis un temps mort', async () => {
    vi.useFakeTimers();
    _setFirstRenderDoneForTesting(false);
    const cb = vi.fn();
    afterFirstRender(cb, 50);
    await vi.advanceTimersByTimeAsync(100);
    expect(cb).not.toHaveBeenCalled(); // pas de page affichée : rien
    _setFirstRenderDoneForTesting(true);
    afterFirstRender(cb, 50);
    await vi.advanceTimersByTimeAsync(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('une tâche différée en échec ne casse rien', async () => {
    vi.useFakeTimers();
    _setFirstRenderDoneForTesting(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    afterFirstRender(() => {
      throw new Error('boum');
    }, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function sessionAt(id: string, day: number) {
  return {
    id,
    name: 'Push A',
    startedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`,
    entries: [],
  };
}

describe('loadSessions : appels simultanés regroupés', () => {
  it('une seule lecture du stockage, une copie par appelant', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, sessionAt('a', 10));
    await saveSession(storage, sessionAt('b', 12));
    const get = vi.spyOn(storage, 'get');
    const [x, y, z] = await Promise.all([
      loadSessions(storage),
      loadSessions(storage),
      loadSessions(storage),
    ]);
    const sessionReads = get.mock.calls.filter(([k]) =>
      String(k).startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX),
    );
    expect(sessionReads).toHaveLength(2); // une fois chaque séance
    expect(x.map((s) => s.id)).toEqual(['a', 'b']);
    expect(y).toEqual(x);
    expect(y[0]).not.toBe(x[0]); // copie : un appelant ne modifie pas la liste d'un autre
    expect(z).not.toBe(y);
  });

  it('rien n’est gardé : un appel suivant relit (séance ajoutée entre-temps)', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, sessionAt('a', 10));
    expect(await loadSessions(storage)).toHaveLength(1);
    await saveSession(storage, sessionAt('b', 12));
    expect(await loadSessions(storage)).toHaveLength(2);
  });

  it('une séance enregistrée pendant une lecture : l’appel suivant la voit', async () => {
    const storage = new InMemoryStorage();
    await saveSession(storage, sessionAt('a', 10));
    const first = loadSessions(storage);
    await saveSession(storage, sessionAt('b', 12));
    const second = loadSessions(storage);
    await first;
    expect((await second).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('pageTemplate : préchargement partagé', () => {
  it('deux demandes simultanées, un seul téléchargement', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => '<div>accueil</div>',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const load = pageTemplate('/static/assets/dashboard.txt');
    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe('<div>accueil</div>');
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('échec : la demande suivante réessaie', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('hors ligne'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => 'ok',
      });
    vi.stubGlobal('fetch', fetchMock);
    const load = pageTemplate('/static/assets/x.txt');
    await expect(load()).rejects.toThrow('hors ligne');
    expect(await load()).toBe('ok');
  });
});
