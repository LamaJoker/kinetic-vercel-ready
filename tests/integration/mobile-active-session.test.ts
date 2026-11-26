/**
 * Mobile — séance en cours face à une fermeture forcée de l'app (iOS tue l'app pendant
 * un repos, batterie vide) et au stockage plein.
 *
 * Complète sync-scenarios.test.ts › « Mobile » (instantané écrit directement) en passant
 * par le VRAI chemin de la page Séances : `createActiveSessionWriter` (écritures
 * regroupées + flush au passage en arrière-plan) → `writeActiveSession` → SyncedStorage
 * sur l'IndexedDB en mémoire, puis reprise par `loadActiveSession` / `restoreActiveSession`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  ACTIVE_SESSION_UNSAVED_MESSAGE,
  createActiveSessionWriter,
  loadActiveSession,
  restoreActiveSession,
  snapshotActiveSession,
  writeActiveSession,
  type ActiveSessionSnapshot,
} from '../../apps/web/src/lib/training/active-session';
import { saveSession } from '../../apps/web/src/lib/training/storage';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types';
import { FakeSyncServer, cloudSessions, phoneOf, type Phone } from '../support/phone';

const ALICE = 'user-alice';

/** Minuteur manuel : l'écriture regroupée part quand le test le décide. */
function manualTimers() {
  let pending: (() => void) | null = null;
  return {
    timers: {
      set: (fn: () => void) => {
        pending = fn;
        return 1;
      },
      clear: () => {
        pending = null;
      },
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

function liveSession(sets: number): WorkoutSession {
  return {
    id: 'live',
    name: 'Push A',
    startedAt: '2026-11-25T09:30:00.000Z',
    entries: [
      {
        exerciseId: 'bench',
        sets: Array.from({ length: sets }, (_, i) => ({
          setIndex: i,
          reps: 8,
          weightKg: 80,
          rpe: 8,
          performedAt: `2026-11-25T09:${String(31 + i * 3).padStart(2, '0')}:00.000Z`,
        })),
      },
    ],
  };
}

function snap(phone: Phone, sets: number, restSec = 0): ActiveSessionSnapshot {
  return snapshotActiveSession(
    {
      session: liveSession(sets),
      restEndsAtMs: restSec > 0 ? phone.clock.ms + restSec * 1000 : 0,
      restTotalSec: 120,
      restPresetSec: 120,
      activeExerciseId: 'bench',
    },
    phone.clock.ms,
  )!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Mobile — fermeture forcée pendant une séance', () => {
  it('séries regroupées puis app passée en arrière-plan (flush) et tuée : séance retrouvée intacte, repos recalé', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    const t = manualTimers();
    const writer = createActiveSessionWriter(
      (s) => writeActiveSession(phone.storage, s),
      400,
      t.timers,
    );

    writer.schedule(snap(phone, 1));
    writer.schedule(snap(phone, 2)); // deux séries rapprochées : une seule écriture
    t.fire();
    await writer.flush();
    writer.schedule(snap(phone, 3, 90)); // 3e série, repos de 90 s lancé
    // iOS : l'app passe en arrière-plan (visibilitychange → flush), puis elle est tuée.
    await writer.flush();
    phone.kill();

    phone.clock.ms += 30_000; // rouverte 30 s plus tard
    const s = await phone.startup();
    const saved = await loadActiveSession(s);
    expect(saved?.session.entries[0]?.sets).toHaveLength(3);
    const state = restoreActiveSession(saved!, phone.clock.ms);
    expect(state.restRemainingSec).toBe(60);
    expect(state.activeExerciseId).toBe('bench');
    // Brouillon propre à l'appareil : jamais envoyé au cloud.
    expect(server.live(ALICE)[STORAGE_KEYS.TRAINING_ACTIVE_SESSION]).toBeUndefined();

    // Fin de séance après la reprise : enregistrée, envoyée, brouillon effacé.
    await saveSession(s, { ...liveSession(3), endedAt: '2026-11-25T10:10:00.000Z' });
    await writeActiveSession(s, null);
    await s.flushPendingWrites();
    expect(cloudSessions(server, ALICE)).toEqual({ live: 'Push A' });
    expect(await loadActiveSession(s)).toBeNull();
    phone.dispose();
  });

  it('tuée AVANT l écriture regroupée : la dernière série écrite est retrouvée (perte bornée à une série)', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    const t = manualTimers();
    const writer = createActiveSessionWriter(
      (s) => writeActiveSession(phone.storage, s),
      400,
      t.timers,
    );
    writer.schedule(snap(phone, 4));
    t.fire();
    await writer.flush();
    writer.schedule(snap(phone, 5)); // pas encore écrite (anti-rebond de 400 ms)
    phone.kill();

    const s = await phone.startup();
    expect((await loadActiveSession(s))?.session.entries[0]?.sets).toHaveLength(4);
    phone.dispose();
  });

  it('stockage plein pendant la séance : l utilisateur est prévenu, la base garde le dernier instantané valide', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOf(server, ALICE);
    const notices: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent<{ message: string }>) => {
        if (e.type === STORAGE_KEYS.EVENT_NOTIFY) notices.push(e.detail.message);
        return true;
      },
    });
    const writer = createActiveSessionWriter((s) => writeActiveSession(phone.storage, s));
    writer.schedule(snap(phone, 2));
    await writer.flush();

    phone.fake.failNext(
      (op) =>
        op.kind === 'put' && op.store === 'kv' && op.key === STORAGE_KEYS.TRAINING_ACTIVE_SESSION,
      'QuotaExceededError',
    );
    writer.schedule(snap(phone, 3));
    await writer.flush();
    expect(writer.failing()).toBe(true);
    expect(notices).toContain(ACTIVE_SESSION_UNSAVED_MESSAGE);

    phone.kill();
    const s = await phone.startup();
    // Rien de corrompu : l'instantané précédent, complet, est repris.
    expect((await loadActiveSession(s))?.session.entries[0]?.sets).toHaveLength(2);
    phone.dispose();
  });
});
