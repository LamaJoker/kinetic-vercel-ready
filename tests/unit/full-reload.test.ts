/**
 * Navigation pleine page voulue par l'app (sync.md § 4.11 bis) : écritures en cours
 * attendues, connexions IndexedDB fermées, puis `location.replace` (aucune page laissée en
 * cache de retour arrière) — ou `reload` pour la page courante.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeAllLocalDatabases,
  settleWithin,
  trackConnection,
} from '../../packages/adapter-web/src/sync/connections.js';
import { fullReload } from '../../apps/web/src/lib/full-reload.js';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.unstubAllGlobals();
});

function fakeLocation(events: string[]) {
  return {
    replace: vi.fn((path: string) => events.push(`replace ${path}`)),
    reload: vi.fn(() => events.push('reload')),
    assign: vi.fn(),
  };
}

describe('fullReload', () => {
  it('attend la fin de l’écriture en cours, ferme les bases, PUIS remplace la page', async () => {
    const events: string[] = [];
    const location = fakeLocation(events);
    vi.stubGlobal('window', { location });
    let finishWrite: () => void = () => undefined;
    const write = new Promise<void>((r) => (finishWrite = r));
    stops.push(
      trackConnection({
        suspend: async (waitMs) => {
          events.push(`attente ${waitMs} ms`);
          await settleWithin([write], waitMs);
          events.push('fermée');
        },
      }),
    );
    const leaving = fullReload('/');
    await Promise.resolve();
    expect(location.replace).not.toHaveBeenCalled(); // écriture pas encore terminée
    events.push('écriture terminée');
    finishWrite();
    await leaving;
    expect(events).toEqual(['attente 3000 ms', 'écriture terminée', 'fermée', 'replace /']);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('sans chemin : recharge la page courante, après fermeture', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', { location: fakeLocation(events) });
    stops.push(trackConnection({ suspend: async () => void events.push('fermée') }));
    await fullReload(undefined, 1000);
    expect(events).toEqual(['fermée', 'reload']);
  });

  it('écriture bloquée (IndexedDB figé) : attente bornée, la navigation a lieu quand même', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', { location: fakeLocation(events) });
    const never = new Promise<void>(() => undefined);
    stops.push(trackConnection({ suspend: (waitMs) => settleWithin([never], waitMs) }));
    const started = Date.now();
    await fullReload('/login', 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events).toEqual(['replace /login']);
  });

  it('fermeture en échec : journalisée, jamais bloquante', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', { location: fakeLocation(events) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stops.push(
      trackConnection({
        suspend: () => {
          throw new Error('déjà fermée');
        },
      }),
    );
    await fullReload('/onboarding');
    expect(events).toEqual(['replace /onboarding']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('closeAllLocalDatabases', () => {
  it('waitMs : 0 — toutes les suspensions lancées de façon synchrone (pagehide)', () => {
    const calls: number[] = [];
    stops.push(trackConnection({ suspend: async (w) => void calls.push(w) }));
    stops.push(trackConnection({ suspend: async (w) => void calls.push(w) }));
    void closeAllLocalDatabases({ waitMs: 0 });
    expect(calls).toEqual([0, 0]);
  });

  it('connexion retirée (fermeture définitive) : plus suspendue', async () => {
    const suspend = vi.fn(async () => undefined);
    const stop = trackConnection({ suspend });
    stop();
    await closeAllLocalDatabases();
    expect(suspend).not.toHaveBeenCalled();
  });
});
