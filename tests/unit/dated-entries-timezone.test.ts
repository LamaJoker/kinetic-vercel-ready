/**
 * Saisies datées autour de MINUIT dans des fuseaux éloignés de l'UTC : la date par défaut,
 * la borne « pas dans le futur » et l'affichage suivent le jour LOCAL, jamais le jour UTC.
 * (Los Angeles à 23 h 30 : déjà le lendemain en UTC ; Auckland à 0 h 30 : encore la veille en UTC.)
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const ORIGINAL_TZ = process.env['TZ'];

const stored = new Map<string, unknown>();
const storage = {
  get: vi.fn(async (k: string) => stored.get(k) ?? null),
  set: vi.fn(async (k: string, v: unknown) => void stored.set(k, v)),
  remove: vi.fn(),
  keys: vi.fn(async () => [...stored.keys()]),
  clear: vi.fn(),
};

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn(async () => ({ storage })) }));
vi.mock('../../apps/web/src/lib/health.js', () => ({ writeBodyweight: vi.fn() }));
vi.mock('../../apps/web/src/lib/haptics.js', () => ({
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));
vi.mock('@capacitor/camera', () => ({ Camera: {}, CameraResultType: {}, CameraSource: {} }));

import {
  STORAGE_KEYS,
  currentBodyweightKg,
  defaultPastTiming,
  localDateTime,
  validatePastTiming,
} from '@kinetic/core';
import { bodyweight } from '../../apps/web/src/pages/bodyweight.page.js';
import { mensurations } from '../../apps/web/src/pages/mensurations.page.js';

const CASES = [
  // 23 h 30 le 28 à Los Angeles = 07 h 30 le 29 en UTC.
  { tz: 'America/Los_Angeles', now: '2026-11-29T07:30:00.000Z', today: '2026-11-28' },
  // 0 h 30 le 29 à Auckland = 11 h 30 le 28 en UTC.
  { tz: 'Pacific/Auckland', now: '2026-11-28T11:30:00.000Z', today: '2026-11-29' },
] as const;

beforeEach(() => {
  stored.clear();
  vi.stubGlobal('window', { dispatchEvent: () => true });
  vi.stubGlobal('document', { getElementById: () => null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env['TZ'];
  else process.env['TZ'] = ORIGINAL_TZ;
});

describe.each(CASES)('fuseau $tz autour de minuit', ({ tz, now, today }) => {
  const tomorrow = (() => {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    return t.toISOString().slice(0, 10);
  })();

  beforeEach(() => {
    process.env['TZ'] = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
  });

  it('le fuseau est bien appliqué', () => {
    expect(new Date().getDate()).toBe(Number(today.slice(8)));
  });

  it('pesée : date par défaut = jour local, ce jour accepté, le lendemain refusé', async () => {
    const s = bodyweight();
    expect(s.newDate).toBe(today);
    expect(s.maxDate).toBe(today);
    s.newWeight = 80;
    expect(s.dateError).toBeNull();
    expect(s.canSave).toBe(true);
    await s.addEntry();
    const saved = stored.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES) as Array<{ date: string }>;
    expect(saved.map((e) => e.date)).toEqual([today]);
    expect(currentBodyweightKg(saved)).toBe(80);

    s.newDate = tomorrow;
    s.newWeight = 81;
    expect(s.dateError).toBe('La date ne peut pas être dans le futur.');
    expect(s.canSave).toBe(false);
  });

  it('pesée : la date affichée est celle du jour saisi (pas la veille)', () => {
    const s = bodyweight();
    const day = Number(today.slice(8));
    expect(s.formatDate(today).startsWith(String(day).padStart(2, '0'))).toBe(true);
  });

  it('mensurations : date par défaut = jour local, lendemain refusé, affichage du bon jour', async () => {
    const s = mensurations();
    expect(s.fDate).toBe(today);
    expect(s.maxDate).toBe(today);
    s.fWaist = 80;
    expect(s.canSave).toBe(true);
    await s.addEntry();
    const saved = stored.get(STORAGE_KEYS.MEASUREMENTS_ENTRIES) as Array<{ date: string }>;
    expect(saved.map((e) => e.date)).toEqual([today]);
    expect(s.formatDate(today).startsWith(String(Number(today.slice(8))))).toBe(true);
    s.fDate = tomorrow;
    expect(s.canSave).toBe(false);
  });

  it('séance passée : valeurs par défaut valides et date de fin bornée à maintenant', () => {
    const at = new Date();
    const d = defaultPastTiming(at);
    const start = localDateTime(d.date, d.time);
    expect(validatePastTiming(start, d.durationMin, at)).toBeNull();
    // Commencée à 0 h 00 du jour local : encore acceptée si elle est finie.
    expect(validatePastTiming(localDateTime(today, '00:00'), 1, at)).toBeNull();
    expect(validatePastTiming(localDateTime(tomorrow, '00:00'), 1, at)).toBe(
      'La date ne peut pas être dans le futur.',
    );
  });
});
