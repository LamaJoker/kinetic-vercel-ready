import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  ImpactStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationType: { Success: 'SUCCESS', Error: 'ERROR' },
}));

import {
  hapticLight,
  hapticMedium,
  hapticHeavy,
  hapticSuccess,
  hapticError,
} from '../../apps/web/src/lib/haptics.js';
import { Capacitor } from '@capacitor/core';
import { Haptics } from '@capacitor/haptics';

describe('Haptics (web platform)', () => {
  let vibrateMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vibrateMock = vi.fn();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.stubGlobal('navigator', { vibrate: vibrateMock });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('hapticLight calls navigator.vibrate(40)', async () => {
    hapticLight();
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks
    expect(vibrateMock).toHaveBeenCalledWith(40);
  });

  it('hapticMedium calls navigator.vibrate(80)', async () => {
    hapticMedium();
    await new Promise((r) => setTimeout(r, 0));
    expect(vibrateMock).toHaveBeenCalledWith(80);
  });

  it('hapticHeavy calls navigator.vibrate(150)', async () => {
    hapticHeavy();
    await new Promise((r) => setTimeout(r, 0));
    expect(vibrateMock).toHaveBeenCalledWith(150);
  });

  it('hapticSuccess calls navigator.vibrate with pattern', async () => {
    hapticSuccess();
    await new Promise((r) => setTimeout(r, 0));
    expect(vibrateMock).toHaveBeenCalledWith([50, 40, 100]);
  });

  it('hapticError calls navigator.vibrate with error pattern', async () => {
    hapticError();
    await new Promise((r) => setTimeout(r, 0));
    expect(vibrateMock).toHaveBeenCalledWith([100, 50, 100, 50, 100]);
  });
});

describe('Haptics (native platform)', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.stubGlobal('navigator', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('hapticLight calls Haptics.impact', async () => {
    hapticLight();
    await new Promise((r) => setTimeout(r, 0));
    expect(Haptics.impact).toHaveBeenCalled();
  });

  it('hapticSuccess calls Haptics.notification', async () => {
    hapticSuccess();
    await new Promise((r) => setTimeout(r, 0));
    expect(Haptics.notification).toHaveBeenCalled();
  });

  it('hapticError calls Haptics.notification', async () => {
    hapticError();
    await new Promise((r) => setTimeout(r, 0));
    expect(Haptics.notification).toHaveBeenCalled();
  });
});
