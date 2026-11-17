import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const health = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  requestAuthorization: vi.fn(),
  saveSample: vi.fn(),
  queryAggregated: vi.fn(),
  readSamples: vi.fn(),
  openHealthConnectSettings: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'android') },
}));
vi.mock('@capgo/capacitor-health', () => ({ Health: health }));

import { Capacitor } from '@capacitor/core';
import {
  disableHealth,
  enableHealth,
  healthAvailability,
  healthEnabled,
  lastNightWindow,
  openHealthSettings,
  readHealthToday,
  sleepMinutes,
  writeBodyweight,
} from '../../apps/web/src/lib/health.js';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
  for (const fn of Object.values(health)) fn.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

const granted = { readAuthorized: ['steps'], readDenied: [], writeAuthorized: [], writeDenied: [] };

describe('disponibilité et activation', () => {
  it('reconnaît Health Connect installé, absent ou hors Android', async () => {
    health.isAvailable.mockResolvedValueOnce({ available: true });
    expect(await healthAvailability()).toBe('available');
    health.isAvailable.mockResolvedValueOnce({ available: false });
    expect(await healthAvailability()).toBe('not-installed');
    vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
    expect(await healthAvailability()).toBe('unsupported');
  });

  it("s'active seulement si une autorisation est accordée", async () => {
    health.requestAuthorization.mockResolvedValueOnce(granted);
    expect(await enableHealth()).toBe(true);
    expect(healthEnabled()).toBe(true);
    disableHealth();
    expect(healthEnabled()).toBe(false);

    health.requestAuthorization.mockResolvedValueOnce({ ...granted, readAuthorized: [] });
    expect(await enableHealth()).toBe(false);
    health.requestAuthorization.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await enableHealth()).toBe(false);
    warn.mockRestore();
  });

  it('ouvre les réglages Health Connect sans échouer', async () => {
    health.openHealthConnectSettings.mockRejectedValueOnce(new Error('absent'));
    await expect(openHealthSettings()).resolves.toBeUndefined();
  });
});

describe('writeBodyweight', () => {
  it("n'écrit rien tant que Health Connect n'est pas activé", async () => {
    await writeBodyweight(80, 15);
    expect(health.saveSample).not.toHaveBeenCalled();
  });

  it('enregistre le poids et la masse grasse', async () => {
    health.requestAuthorization.mockResolvedValueOnce(granted);
    await enableHealth();
    await writeBodyweight(80.4, 15.2);
    expect(health.saveSample).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: 'weight', value: 80.4, unit: 'kilogram' }),
    );
    expect(health.saveSample).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: 'bodyFat', value: 15.2, unit: 'percent' }),
    );
    health.saveSample.mockClear();
    await writeBodyweight(80, null);
    expect(health.saveSample).toHaveBeenCalledTimes(1);
  });
});

describe('sommeil', () => {
  it('retire les éveils quand les phases sont connues', () => {
    expect(
      sleepMinutes({
        dataType: 'sleep',
        value: 480,
        unit: 'minute',
        startDate: '',
        endDate: '',
        hasStageData: true,
        stages: [
          { stage: 'deep', durationMinutes: 300, startDate: '', endDate: '' },
          { stage: 'awake', durationMinutes: 40, startDate: '', endDate: '' },
          { stage: 'rem', durationMinutes: 100, startDate: '', endDate: '' },
        ],
      }),
    ).toBe(400);
    expect(
      sleepMinutes({ dataType: 'sleep', value: 420, unit: 'minute', startDate: '', endDate: '' }),
    ).toBe(420);
  });

  it('cherche la nuit à partir de 18 h la veille', () => {
    const now = new Date(2026, 4, 13, 9, 30);
    expect(lastNightWindow(now)).toEqual({ start: new Date(2026, 4, 12, 18, 0), end: now });
  });
});

describe('readHealthToday', () => {
  const now = new Date(2026, 4, 13, 9, 30);

  it('renvoie du vide tant que ce n’est pas activé', async () => {
    expect(await readHealthToday(now)).toEqual({ steps: null, sleepMinutes: null });
  });

  it('additionne les pas du jour et le sommeil de la nuit', async () => {
    health.requestAuthorization.mockResolvedValueOnce(granted);
    await enableHealth();
    health.queryAggregated.mockResolvedValueOnce({ samples: [{ value: 5000.4 }, { value: 1200 }] });
    health.readSamples.mockResolvedValueOnce({
      samples: [
        { value: 450, endDate: new Date(2026, 4, 13, 7, 0).toISOString() },
        { value: 60, endDate: new Date(2026, 4, 12, 15, 0).toISOString() },
      ],
    });
    expect(await readHealthToday(now)).toEqual({ steps: 6200, sleepMinutes: 450 });
  });

  it('garde ce qui a pu être lu quand une lecture échoue', async () => {
    health.requestAuthorization.mockResolvedValueOnce(granted);
    await enableHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    health.queryAggregated.mockRejectedValueOnce(new Error('denied'));
    health.readSamples.mockResolvedValueOnce({ samples: [] });
    expect(await readHealthToday(now)).toEqual({ steps: null, sleepMinutes: null });
    warn.mockRestore();
  });
});
