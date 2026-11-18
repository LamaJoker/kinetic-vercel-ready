import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Environnement node : localStorage minimal.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
}

// Mock @capacitor/core and @capacitor/haptics before importing haptics.ts
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: vi.fn().mockResolvedValue(undefined),
    notification: vi.fn().mockResolvedValue(undefined),
  },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));

import {
  hapticLight,
  hapticMedium,
  hapticHeavy,
  hapticSuccess,
  hapticWarning,
  hapticError,
  hapticTap,
  hapticCelebrate,
  hapticsEnabled,
  hapticsSupported,
  setHapticsEnabled,
  HAPTICS_PREF_KEY,
  HAPTIC_MIN_GAP_MS,
  _takeSlot,
  _resetHapticsForTests,
} from '../../apps/web/src/lib/haptics.js';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

/** Laisse l'import dynamique et la promesse se résoudre. */
const flush = async (): Promise<void> => {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  _resetHapticsForTests();
  localStorage.removeItem(HAPTICS_PREF_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Haptics (web : aucune vibration)', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  it('ne fait rien sur le web, même si navigator.vibrate existe', async () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    hapticLight();
    hapticSuccess();
    hapticCelebrate();
    await flush();
    expect(vibrate).not.toHaveBeenCalled();
    expect(Haptics.impact).not.toHaveBeenCalled();
    expect(Haptics.notification).not.toHaveBeenCalled();
  });

  it('hapticsSupported() est faux sur le web', () => {
    expect(hapticsSupported()).toBe(false);
  });
});

describe('Haptics (natif)', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  });

  it.each([
    ['hapticLight', hapticLight, 'LIGHT'],
    ['hapticTap', hapticTap, 'LIGHT'],
    ['hapticMedium', hapticMedium, 'MEDIUM'],
    ['hapticHeavy', hapticHeavy, 'HEAVY'],
    ['hapticCelebrate', hapticCelebrate, 'HEAVY'],
  ])('%s → Haptics.impact(%s)', async (_name, fn, style) => {
    fn();
    await flush();
    expect(Haptics.impact).toHaveBeenCalledWith({ style });
  });

  it.each([
    ['hapticSuccess', hapticSuccess, 'SUCCESS'],
    ['hapticWarning', hapticWarning, 'WARNING'],
    ['hapticError', hapticError, 'ERROR'],
  ])('%s → Haptics.notification(%s)', async (_name, fn, type) => {
    fn();
    await flush();
    expect(Haptics.notification).toHaveBeenCalledWith({ type });
  });

  it('avale les erreurs du plugin', async () => {
    vi.mocked(Haptics.impact).mockRejectedValueOnce(new Error('not supported'));
    vi.mocked(Haptics.notification).mockRejectedValueOnce(new Error('not supported'));
    expect(() => {
      hapticLight();
      hapticSuccess();
    }).not.toThrow();
    await flush();
  });

  it('respecte le réglage « Vibrations » coupé', async () => {
    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
    hapticTap();
    hapticSuccess();
    await flush();
    expect(Haptics.impact).not.toHaveBeenCalled();
    expect(Haptics.notification).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    expect(hapticsEnabled()).toBe(true);
    hapticTap();
    await flush();
    expect(Haptics.impact).toHaveBeenCalledTimes(1);
  });

  it('pas de rafale : deux appels rapprochés ne vibrent qu’une fois', async () => {
    hapticTap();
    hapticTap();
    hapticTap();
    await flush();
    expect(Haptics.impact).toHaveBeenCalledTimes(1);
  });
});

describe('anti-rafale (_takeSlot)', () => {
  it('refuse un second retour du même type avant HAPTIC_MIN_GAP_MS', () => {
    expect(_takeSlot('light', 1000)).toBe(true);
    expect(_takeSlot('light', 1000 + HAPTIC_MIN_GAP_MS - 1)).toBe(false);
    expect(_takeSlot('light', 1000 + HAPTIC_MIN_GAP_MS)).toBe(true);
  });

  it('les types sont indépendants', () => {
    expect(_takeSlot('light', 1000)).toBe(true);
    expect(_takeSlot('success', 1001)).toBe(true);
  });
});

describe('réglage par défaut', () => {
  it('actif quand rien n’est enregistré', () => {
    expect(hapticsEnabled()).toBe(true);
  });
});
