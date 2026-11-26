import { describe, it, expect, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  ACTIVE_SESSION_KEY,
  ACTIVE_SESSION_MAX_AGE_MS,
  ACTIVE_SESSION_SAVED_AGAIN_MESSAGE,
  ACTIVE_SESSION_UNSAVED_MESSAGE,
  createActiveSessionWriter,
  formatActiveDuration,
  formatActiveAge,
  isActiveSessionStale,
  loadActiveSession,
  parseActiveSession,
  restoreActiveSession,
  restRemainingAt,
  snapshotActiveSession,
  summarizeActiveSession,
  writeActiveSession,
  type ActiveSessionSnapshot,
} from '../../apps/web/src/lib/training/active-session.js';
import { isBackedUpKey } from '../../apps/web/src/lib/backup.js';
import { isLocalOnlyKey } from '../../packages/adapter-web/src/supabase/HybridStorage.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

vi.mock('../../apps/web/src/deps', () => ({ getDeps: vi.fn() }));
const { shouldShowActiveBanner } =
  await import('../../apps/web/src/components/active-session-banner.js');

const T0 = Date.parse('2026-11-18T10:00:00.000Z');

function session(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id: 's1',
    name: 'Push A',
    startedAt: new Date(T0).toISOString(),
    entries: [
      {
        exerciseId: 'bench',
        sets: [
          {
            setIndex: 0,
            reps: 8,
            weightKg: 60,
            rpe: 8,
            performedAt: new Date(T0 + 60_000).toISOString(),
          },
        ],
      },
      { exerciseId: 'ohp', sets: [] },
    ],
    ...overrides,
  } as WorkoutSession;
}

function snap(overrides: Partial<ActiveSessionSnapshot> = {}): ActiveSessionSnapshot {
  return {
    ...snapshotActiveSession(
      {
        session: session(),
        restEndsAtMs: T0 + 5 * 60_000 + 90_000,
        restTotalSec: 90,
        restPresetSec: 90,
        activeExerciseId: 'bench',
      },
      T0 + 5 * 60_000,
    )!,
    ...overrides,
  };
}

describe('snapshotActiveSession (sérialisation)', () => {
  it('renvoie null sans séance (= effacement)', () => {
    expect(
      snapshotActiveSession(
        {
          session: null,
          restEndsAtMs: 0,
          restTotalSec: 90,
          restPresetSec: 90,
          activeExerciseId: null,
        },
        T0,
      ),
    ).toBeNull();
  });

  it('stocke la fin du repos en heure absolue et une copie JSON pure', () => {
    const s = snap();
    expect(s.v).toBe(1);
    expect(s.restEndsAtMs).toBe(T0 + 5 * 60_000 + 90_000);
    expect(s.savedAtMs).toBe(T0 + 5 * 60_000);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.session.entries[0]!.sets).toHaveLength(1);
  });

  it('ne garde pas un repos déjà terminé', () => {
    const s = snapshotActiveSession(
      {
        session: session(),
        restEndsAtMs: T0 - 1,
        restTotalSec: 90,
        restPresetSec: 90,
        activeExerciseId: null,
      },
      T0,
    )!;
    expect(s.restEndsAtMs).toBe(0);
  });

  it('aller-retour sérialisation → validation sans perte', () => {
    const s = snap();
    expect(parseActiveSession(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('parseActiveSession (validation)', () => {
  it.each([
    ['null', null],
    ['chaîne', 'x'],
    ['mauvaise version', { ...snap(), v: 2 }],
    ['sans séance', { ...snap(), session: null }],
    ['date de début invalide', { ...snap(), session: { ...session(), startedAt: 'hier' } }],
    ['entrées invalides', { ...snap(), session: { ...session(), entries: [{ sets: [] }] } }],
    ['séance déjà terminée', { ...snap(), session: { ...session(), endedAt: '2026-11-18' } }],
  ])('rejette : %s', (_label, raw) => {
    expect(parseActiveSession(raw)).toBeNull();
  });

  it('borne les valeurs de repos corrompues', () => {
    const p = parseActiveSession({
      ...snap(),
      restEndsAtMs: 'n/a',
      restPresetSec: 99999,
      restTotalSec: -4,
      activeExerciseId: 42,
    })!;
    expect(p.restEndsAtMs).toBe(0);
    expect(p.restPresetSec).toBe(600);
    expect(p.restTotalSec).toBe(1);
    expect(p.activeExerciseId).toBeNull();
  });
});

describe('reprise', () => {
  it('recalcule le repos restant depuis l’heure de fin', () => {
    const s = snap(); // repos jusqu'à T0+6:30
    const now = T0 + 6 * 60_000; // 30 s restantes
    expect(restRemainingAt(s, now)).toBe(30);
    const r = restoreActiveSession(s, now);
    expect(r.restRemainingSec).toBe(30);
    expect(r.restEndsAtMs).toBe(s.restEndsAtMs);
    expect(r.session.startedAt).toBe(new Date(T0).toISOString());
    expect(r.activeExerciseId).toBe('bench');
  });

  it('repos écoulé pendant l’absence : plus de repos', () => {
    const r = restoreActiveSession(snap(), T0 + 20 * 60_000);
    expect(r.restRemainingSec).toBe(0);
    expect(r.restEndsAtMs).toBe(0);
  });

  it('durée basée sur l’heure de début', () => {
    expect(formatActiveDuration(new Date(T0).toISOString(), T0 + 65_000)).toBe('1:05');
    expect(formatActiveDuration(new Date(T0).toISOString(), T0 + 3_725_000)).toBe('1:02:05');
    expect(formatActiveDuration('invalide', T0)).toBe('0:00');
  });

  it('âge lisible d’une séance ancienne', () => {
    const iso = new Date(T0).toISOString();
    expect(formatActiveAge(iso, T0 + 13 * 3_600_000 + 59_000)).toBe('13 h');
    expect(formatActiveAge(iso, T0 + 3 * 24 * 3_600_000)).toBe('3 jours');
  });

  it('résumé pour le bandeau', () => {
    expect(summarizeActiveSession(snap())).toEqual({
      name: 'Push A',
      startedAt: new Date(T0).toISOString(),
    });
    expect(summarizeActiveSession(null)).toBeNull();
  });
});

describe('expiration (12 h)', () => {
  it('reprend sans demander sous 12 h', () => {
    expect(isActiveSessionStale(snap(), T0 + ACTIVE_SESSION_MAX_AGE_MS)).toBe(false);
  });

  it('demande au-delà de 12 h', () => {
    expect(isActiveSessionStale(snap(), T0 + ACTIVE_SESSION_MAX_AGE_MS + 1)).toBe(true);
  });
});

describe('stockage', () => {
  it('écrit, relit puis efface', async () => {
    const storage = new InMemoryStorage();
    await writeActiveSession(storage, snap());
    expect(await loadActiveSession(storage)).toEqual(snap());
    await writeActiveSession(storage, null);
    expect(await loadActiveSession(storage)).toBeNull();
    expect(await storage.keys()).not.toContain(ACTIVE_SESSION_KEY);
  });

  it('ignore un contenu corrompu', async () => {
    const storage = new InMemoryStorage();
    await storage.set(ACTIVE_SESSION_KEY, { v: 1, session: 'oops' });
    expect(await loadActiveSession(storage)).toBeNull();
  });

  it('clé locale : ni synchronisée, ni sauvegardée, ni lue comme séance', () => {
    expect(ACTIVE_SESSION_KEY).toBe(STORAGE_KEYS.TRAINING_ACTIVE_SESSION);
    expect(ACTIVE_SESSION_KEY.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX)).toBe(false);
    expect(isLocalOnlyKey(ACTIVE_SESSION_KEY)).toBe(true);
    expect(isBackedUpKey(ACTIVE_SESSION_KEY)).toBe(false);
  });
});

describe('createActiveSessionWriter (écritures regroupées)', () => {
  function fakeTimers() {
    let fn: (() => void) | null = null;
    return {
      timers: {
        set: (f: () => void) => {
          fn = f;
          return 1;
        },
        clear: () => {
          fn = null;
        },
      },
      fire: () => fn?.(),
    };
  }

  it('regroupe plusieurs changements rapprochés en une écriture (la dernière)', async () => {
    const writes: Array<ActiveSessionSnapshot | null> = [];
    const t = fakeTimers();
    const w = createActiveSessionWriter(async (s) => void writes.push(s), 400, t.timers);
    w.schedule(snap({ savedAtMs: 1 }));
    w.schedule(snap({ savedAtMs: 2 }));
    expect(writes).toHaveLength(0);
    expect(w.pending()).toBe(true);
    t.fire();
    await w.flush();
    expect(writes.map((s) => s?.savedAtMs)).toEqual([2]);
    expect(w.pending()).toBe(false);
  });

  it('l’effacement part tout de suite et remplace l’écriture en attente', async () => {
    const writes: Array<ActiveSessionSnapshot | null> = [];
    const t = fakeTimers();
    const w = createActiveSessionWriter(async (s) => void writes.push(s), 400, t.timers);
    w.schedule(snap());
    w.schedule(null);
    await w.flush();
    t.fire();
    await w.flush();
    expect(writes).toEqual([null]);
  });

  it('flush() écrit immédiatement (app mise en arrière-plan)', async () => {
    const storage = new InMemoryStorage();
    const t = fakeTimers();
    const w = createActiveSessionWriter((s) => writeActiveSession(storage, s), 400, t.timers);
    w.schedule(snap());
    await w.flush();
    expect(await loadActiveSession(storage)).toEqual(snap());
  });

  it('un échec d’écriture ne casse pas les suivantes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const w = createActiveSessionWriter(async () => {
      calls++;
      if (calls === 1) throw new Error('quota');
    });
    w.schedule(snap());
    await w.flush();
    w.schedule(null);
    await w.flush();
    expect(calls).toBe(2);
    warn.mockRestore();
  });
});

describe('bandeau « Séance en cours »', () => {
  const summary = { name: 'Push A', startedAt: new Date(T0).toISOString() };

  it('visible sur les autres écrans quand une séance est en cours', () => {
    expect(shouldShowActiveBanner(summary, '/')).toBe(true);
    expect(shouldShowActiveBanner(summary, '/vitalite')).toBe(true);
  });

  it('masqué sur la séance elle-même, les écrans plein cadre, ou sans séance', () => {
    expect(shouldShowActiveBanner(summary, '/seances')).toBe(false);
    expect(shouldShowActiveBanner(summary, '/seances/')).toBe(false);
    expect(shouldShowActiveBanner(summary, '/onboarding')).toBe(false);
    expect(shouldShowActiveBanner(summary, '/legal/cgu')).toBe(false);
    expect(shouldShowActiveBanner(null, '/')).toBe(false);
  });
});

describe('séance en cours non enregistrée (audit stockage local F9)', () => {
  it('échec d écriture : l utilisateur est prévenu (pas seulement la console), puis rassuré', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: Array<{ kind: string; message: string; duration?: number }> = [];
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => {
        if (e.type === STORAGE_KEYS.EVENT_NOTIFY) events.push(e.detail);
        return true;
      },
    });
    let full = true;
    const w = createActiveSessionWriter(async () => {
      if (full) throw new DOMException('quota', 'QuotaExceededError');
    });
    w.schedule(snap());
    await w.flush();
    expect(w.failing()).toBe(true);
    expect(events).toEqual([
      { kind: 'error', message: ACTIVE_SESSION_UNSAVED_MESSAGE, duration: 10_000 },
    ]);
    // Échecs suivants : pas un toast par série, rappel tous les 5 échecs.
    for (let i = 0; i < 3; i++) {
      w.schedule(snap({ savedAtMs: i }));
      await w.flush();
    }
    expect(events).toHaveLength(1);
    w.schedule(snap({ savedAtMs: 9 }));
    await w.flush();
    expect(events).toHaveLength(2);

    full = false;
    w.schedule(snap({ savedAtMs: 10 }));
    await w.flush();
    expect(w.failing()).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'success', message: ACTIVE_SESSION_SAVED_AGAIN_MESSAGE });
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it('le message indique une piste de récupération (terminer la séance, libérer de l espace)', () => {
    expect(ACTIVE_SESSION_UNSAVED_MESSAGE).toMatch(/non protégée/);
    expect(ACTIVE_SESSION_UNSAVED_MESSAGE).toMatch(/termine la séance/);
    expect(ACTIVE_SESSION_UNSAVED_MESSAGE).toMatch(/libère de l’espace/);
  });

  it('callbacks personnalisés : échecs consécutifs comptés, remis à zéro au succès', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: number[] = [];
    let recovered = 0;
    let ok = false;
    const w = createActiveSessionWriter(
      async () => {
        if (!ok) throw new Error('closed');
      },
      400,
      undefined,
      { onFailure: (_e, n) => void seen.push(n), onRecovered: () => void recovered++ },
    );
    w.schedule(snap());
    await w.flush();
    w.schedule(snap());
    await w.flush();
    ok = true;
    w.schedule(snap());
    await w.flush();
    expect(seen).toEqual([1, 2]);
    expect(recovered).toBe(1);
    warn.mockRestore();
  });
});
