import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn(),
}));

// Capacitor and LocalNotifications stubs
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(),
    schedule: vi.fn(),
  },
}));

import { getDeps } from '../../apps/web/src/deps.js';
import { Capacitor } from '@capacitor/core';
import {
  InMemoryStorage,
  FakeClock,
  SequentialIdGenerator,
  SpyNotifier,
} from '../helpers/stubs.js';

function makeDeps(storage = new InMemoryStorage()) {
  return {
    storage,
    clock: new FakeClock('2026-05-16'),
    idGen: new SequentialIdGenerator(),
    notifier: new SpyNotifier(),
  };
}

describe('scheduleStreakReminder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Provide a minimal window so the SSR guard doesn't short-circuit all tests
    vi.stubGlobal('window', globalThis);
    vi.mocked(getDeps).mockResolvedValue(makeDeps() as ReturnType<typeof getDeps>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('does nothing when window is undefined (SSR context)', async () => {
    vi.stubGlobal('window', undefined);
    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduleStreakReminder();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not schedule when time has already passed 20h', async () => {
    // Set current time to 21:00 (delay would be negative)
    vi.setSystemTime(new Date('2026-05-16T21:00:00'));
    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduleStreakReminder();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not schedule when delay is beyond 12 hours', async () => {
    // Set current time to 00:01 (delay > 12h until 20:00)
    vi.setSystemTime(new Date('2026-05-16T00:01:00'));
    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduleStreakReminder();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('schedules a timeout when time is between 08:00 and 20:00', async () => {
    // Set current time to 12:00 — within the 12h window before 20:00
    vi.setSystemTime(new Date('2026-05-16T12:00:00'));
    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    scheduleStreakReminder();
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    // Delay should be positive and ≤ 8 hours
    const delay = setTimeoutSpy.mock.calls[0]?.[1] as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(8 * 60 * 60 * 1000);
  });

  it('does not send notification when reminder already sent today', async () => {
    vi.setSystemTime(new Date('2026-05-16T12:00:00'));
    const today = '2026-05-16';
    const storage = new InMemoryStorage();
    await storage.set('kinetic:reminder:lastDate', today);
    vi.mocked(getDeps).mockResolvedValue(makeDeps(storage) as ReturnType<typeof getDeps>);

    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');

    const notifSpy = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notifSpy, { permission: 'granted' }));

    scheduleStreakReminder();
    // Fast-forward to 20:00
    await vi.runAllTimersAsync();

    expect(notifSpy).not.toHaveBeenCalled();
  });

  it('sends web notification when on PWA and shouldRemind is true', async () => {
    vi.setSystemTime(new Date('2026-05-16T12:00:00'));
    const storage = new InMemoryStorage();
    // No reminder date stored → shouldRemind returns true
    // No daily log with >= 5 entries → shouldRemind returns true
    vi.mocked(getDeps).mockResolvedValue(makeDeps(storage) as ReturnType<typeof getDeps>);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);

    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');

    const notifSpy = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notifSpy, { permission: 'granted' }));

    scheduleStreakReminder();
    await vi.runAllTimersAsync();

    expect(notifSpy).toHaveBeenCalledOnce();
  });

  it('does not send web notification when Notification permission is not granted', async () => {
    vi.setSystemTime(new Date('2026-05-16T12:00:00'));
    vi.mocked(getDeps).mockResolvedValue(makeDeps() as ReturnType<typeof getDeps>);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);

    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');

    const notifSpy = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notifSpy, { permission: 'default' }));

    scheduleStreakReminder();
    await vi.runAllTimersAsync();

    expect(notifSpy).not.toHaveBeenCalled();
  });

  it('records the reminder date after sending notification', async () => {
    vi.setSystemTime(new Date('2026-05-16T12:00:00'));
    const storage = new InMemoryStorage();
    vi.mocked(getDeps).mockResolvedValue(makeDeps(storage) as ReturnType<typeof getDeps>);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);

    const { scheduleStreakReminder } = await import('../../apps/web/src/lib/streak-reminder.js');

    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));

    scheduleStreakReminder();
    await vi.runAllTimersAsync();

    const stored = await storage.get<string>('kinetic:reminder:lastDate');
    expect(stored).toBe('2026-05-16');
  });
});
