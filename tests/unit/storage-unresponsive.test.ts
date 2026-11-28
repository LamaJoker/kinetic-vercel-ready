/**
 * Stockage de l'appareil bloqué (IndexedDB WebKit, sync.md § 4.11) : rechargement
 * UNIQUE (marqueur horodaté en sessionStorage), puis message persistant avec
 * « Réessayer » — jamais de boucle de rechargements.
 */
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  createStorageRecovery,
  RELOAD_GRACE_MS,
  RELOAD_WINDOW_MS,
  STORAGE_UNRESPONSIVE_MESSAGE,
  type StorageRecoveryEnv,
} from '../../apps/web/src/lib/storage-unresponsive.js';

/** Un « appareil » : sessionStorage conservé d'un chargement de page à l'autre. */
function device(start = 1_000_000) {
  const session = new Map<string, string>();
  let now = start;
  const reload = vi.fn();
  const showMessage = vi.fn<(retry: () => void) => void>();
  /** Minuteries en attente (page toujours là après le rechargement demandé). */
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const env: StorageRecoveryEnv = {
    now: () => now,
    session: () => ({
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
    }),
    reload,
    showMessage,
    later: (fn, ms) => void timers.push({ fn, ms }),
  };
  return {
    env,
    timers,
    session,
    reload,
    showMessage,
    advance: (ms: number) => (now += ms),
    /** Nouveau chargement de page (le gestionnaire est recréé, sessionStorage conservé). */
    pageLoad: () => createStorageRecovery(env),
  };
}

describe('reprise du stockage bloqué', () => {
  it('1er blocage : un seul rechargement, marqueur horodaté posé', () => {
    const d = device();
    const handle = d.pageLoad();
    expect(handle()).toBe('reload');
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.session.get(STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT)).toBe('1000000');
    // Blocages suivants dans la même page (autres lectures) : rien de plus.
    expect(handle()).toBe('already-handled');
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.showMessage).not.toHaveBeenCalled();
  });

  it('nouveau blocage après le rechargement : message persistant, PAS de 2e rechargement', () => {
    const d = device();
    d.pageLoad()();
    d.advance(20_000);
    const handle = d.pageLoad();
    expect(handle()).toBe('message');
    expect(d.reload).toHaveBeenCalledTimes(1);
    expect(d.showMessage).toHaveBeenCalledTimes(1);
    expect(handle()).toBe('already-handled');
    expect(d.showMessage).toHaveBeenCalledTimes(1);
  });

  it('« Réessayer » : rechargement demandé par l utilisateur ; un nouvel échec remontre le message', () => {
    const d = device();
    d.pageLoad()();
    d.advance(10_000);
    d.pageLoad()();
    const retry = d.showMessage.mock.calls[0]![0];
    d.advance(60_000);
    retry();
    expect(d.reload).toHaveBeenCalledTimes(2);
    d.advance(10_000);
    expect(d.pageLoad()()).toBe('message');
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it('blocage bien plus tard (hors fenêtre) : nouveau rechargement automatique unique', () => {
    const d = device();
    d.pageLoad()();
    d.advance(RELOAD_WINDOW_MS + 1);
    expect(d.pageLoad()()).toBe('reload');
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it('sessionStorage indisponible : message direct (aucun rechargement sans garde anti-boucle)', () => {
    const reload = vi.fn();
    const showMessage = vi.fn();
    const handle = createStorageRecovery({
      now: () => 0,
      session: () => null,
      reload,
      showMessage,
    });
    expect(handle()).toBe('message');
    expect(reload).not.toHaveBeenCalled();

    const throwing = createStorageRecovery({
      now: () => 0,
      session: () => {
        throw new Error('SecurityError');
      },
      reload,
      showMessage,
    });
    expect(throwing()).toBe('message');
    expect(reload).not.toHaveBeenCalled();
  });

  it('marqueur illisible ou dans le futur (horloge reculée) : traité prudemment', () => {
    const d = device();
    d.session.set(STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT, 'abc');
    expect(d.pageLoad()()).toBe('reload');
    d.session.set(STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT, String(2_000_000));
    // Marqueur « dans le futur » : pas une preuve de rechargement récent → rechargement unique.
    expect(d.pageLoad()()).toBe('reload');
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it('rechargement demandé mais la page est toujours là (navigation retenue) : message quand même', () => {
    const d = device();
    expect(d.pageLoad()()).toBe('reload');
    expect(d.timers).toHaveLength(1);
    expect(d.timers[0]!.ms).toBe(RELOAD_GRACE_MS);
    expect(d.showMessage).not.toHaveBeenCalled();
    d.timers[0]!.fn(); // 10 s plus tard, la page n'a pas été remplacée
    expect(d.showMessage).toHaveBeenCalledTimes(1);
    // « Réessayer » : nouveau rechargement demandé par l'utilisateur.
    d.showMessage.mock.calls[0]![0]();
    expect(d.reload).toHaveBeenCalledTimes(2);
  });

  it('texte du message en français, données présentées comme non perdues', () => {
    expect(STORAGE_UNRESPONSIVE_MESSAGE).toBe(
      "Le stockage de l'appareil ne répond pas. Tes données ne sont pas perdues : ferme complètement l'app puis rouvre-la.",
    );
  });
});
