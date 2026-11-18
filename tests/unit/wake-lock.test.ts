import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSessionWakeLock,
  setWakeLockEnabled,
  wakeLockEnabled,
  wakeLockSupported,
  WAKE_LOCK_PREF_KEY,
  type WakeLockSentinelLike,
} from '../../apps/web/src/lib/wake-lock';

function fakeEnv(visible = true) {
  const state = { visible, requests: 0, held: [] as FakeSentinel[], fail: false };
  class FakeSentinel implements WakeLockSentinelLike {
    released = false;
    private listeners: Array<() => void> = [];
    async release(): Promise<void> {
      this.released = true;
      this.listeners.forEach((l) => l());
    }
    addEventListener(_t: 'release', l: () => void): void {
      this.listeners.push(l);
    }
    /** Le système relâche le verrou (app en arrière-plan). */
    systemRelease(): void {
      void this.release();
    }
  }
  const env = {
    request: vi.fn(async () => {
      state.requests++;
      if (state.fail) throw new Error('NotAllowedError');
      const s = new FakeSentinel();
      state.held.push(s);
      return s;
    }),
    isVisible: () => state.visible,
  };
  return { env, state };
}

afterEach(() => vi.unstubAllGlobals());

describe('écran allumé pendant la séance (Wake Lock)', () => {
  it('pris pendant une séance, relâché à la fin', async () => {
    const { env, state } = fakeEnv();
    const lock = createSessionWakeLock(env);
    expect(lock.isHeld()).toBe(false);
    await lock.setSessionActive(true);
    expect(lock.isHeld()).toBe(true);
    // Chaque série ré-annonce la séance : une seule demande.
    await lock.setSessionActive(true);
    await lock.setSessionActive(true);
    expect(state.requests).toBe(1);
    await lock.setSessionActive(false);
    expect(lock.isHeld()).toBe(false);
    expect(state.held[0]!.released).toBe(true);
  });

  it('redemandé au retour au premier plan', async () => {
    const { env, state } = fakeEnv();
    const lock = createSessionWakeLock(env);
    await lock.setSessionActive(true);
    state.visible = false;
    (state.held[0] as unknown as { systemRelease(): void }).systemRelease();
    await lock.refresh();
    expect(lock.isHeld()).toBe(false);
    state.visible = true;
    await lock.refresh();
    expect(lock.isHeld()).toBe(true);
    expect(state.requests).toBe(2);
  });

  it('rien quand l’app est en arrière-plan ou le réglage coupé', async () => {
    const { env, state } = fakeEnv(false);
    const lock = createSessionWakeLock(env, false);
    await lock.setSessionActive(true);
    expect(state.requests).toBe(0);
    state.visible = true;
    await lock.refresh();
    expect(state.requests).toBe(0);
    await lock.setEnabled(true);
    expect(lock.isHeld()).toBe(true);
    await lock.setEnabled(false);
    expect(lock.isHeld()).toBe(false);
  });

  it('refus du système : silencieux', async () => {
    const { env, state } = fakeEnv();
    state.fail = true;
    const lock = createSessionWakeLock(env);
    await expect(lock.setSessionActive(true)).resolves.toBeUndefined();
    expect(lock.isHeld()).toBe(false);
  });

  it('séance terminée pendant la demande : relâché aussitôt', async () => {
    const { env, state } = fakeEnv();
    const lock = createSessionWakeLock(env);
    const first = lock.setSessionActive(true);
    const second = lock.setSessionActive(false);
    await Promise.all([first, second]);
    expect(lock.isHeld()).toBe(false);
    expect(state.held.every((s) => s.released)).toBe(true);
  });

  it('réglage enregistré, activé par défaut', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const events: unknown[] = [];
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent) => events.push(e.detail) });
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(
          public type: string,
          public init: { detail: unknown },
        ) {}
        get detail() {
          return this.init.detail;
        }
      },
    );
    expect(wakeLockEnabled()).toBe(true);
    setWakeLockEnabled(false);
    expect(store.get(WAKE_LOCK_PREF_KEY)).toBe('0');
    expect(wakeLockEnabled()).toBe(false);
    expect(events).toEqual([false]);
    setWakeLockEnabled(true);
    expect(wakeLockEnabled()).toBe(true);
  });

  it('support détecté par navigator.wakeLock', () => {
    vi.stubGlobal('navigator', {});
    expect(wakeLockSupported()).toBe(false);
    vi.stubGlobal('navigator', { wakeLock: { request: vi.fn() } });
    expect(wakeLockSupported()).toBe(true);
  });
});
