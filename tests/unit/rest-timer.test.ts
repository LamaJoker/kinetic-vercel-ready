import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startRestTimer,
  suggestedRestSec,
  requestNotificationPermission,
} from '../../apps/web/src/lib/training/rest-timer.js';

describe('suggestedRestSec', () => {
  it('returns 180s for RPE >= 9 (strength)', () => {
    expect(suggestedRestSec(9)).toBe(180);
    expect(suggestedRestSec(10)).toBe(180);
  });

  it('returns 90s for RPE 7-8 (hypertrophy)', () => {
    expect(suggestedRestSec(7)).toBe(90);
    expect(suggestedRestSec(8)).toBe(90);
  });

  it('returns 60s for RPE <= 6 (endurance)', () => {
    expect(suggestedRestSec(6)).toBe(60);
    expect(suggestedRestSec(4)).toBe(60);
  });
});

describe('requestNotificationPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns denied when Notification is unavailable', async () => {
    vi.stubGlobal('Notification', undefined);
    const result = await requestNotificationPermission();
    expect(result).toBe('denied');
  });

  it('returns current permission when already granted or denied', async () => {
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: vi.fn(),
    });
    const result = await requestNotificationPermission();
    expect(result).toBe('granted');
  });

  it('calls requestPermission when permission is default', async () => {
    const mockRequest = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: mockRequest,
    });
    const result = await requestNotificationPermission();
    expect(mockRequest).toHaveBeenCalled();
    expect(result).toBe('granted');
  });

  it('returns denied when requestPermission throws', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(new Error('blocked')),
    });
    const result = await requestNotificationPermission();
    expect(result).toBe('denied');
  });
});

describe('startRestTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Stub out vibrate and Notification to avoid side effects
    vi.stubGlobal('navigator', { vibrate: vi.fn() });
    vi.stubGlobal('Notification', { permission: 'denied' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires onTick immediately with initial remaining', () => {
    const ticks: number[] = [];
    startRestTimer({ durationSec: 5, onTick: (r) => ticks.push(r) });
    expect(ticks).toEqual([5]); // immediate tick
  });

  it('counts down each second', () => {
    const ticks: number[] = [];
    startRestTimer({ durationSec: 3, onTick: (r) => ticks.push(r) });
    vi.advanceTimersByTime(3000);
    expect(ticks).toEqual([3, 2, 1, 0]);
  });

  it('calls onDone when reaching 0', () => {
    const onDone = vi.fn();
    startRestTimer({ durationSec: 2, onDone, vibrate: false, notify: false });
    vi.advanceTimersByTime(2000);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('pause stops the countdown', () => {
    const ticks: number[] = [];
    const handle = startRestTimer({ durationSec: 5, onTick: (r) => ticks.push(r) });
    vi.advanceTimersByTime(1000);
    handle.pause();
    vi.advanceTimersByTime(3000); // should not tick while paused
    expect(ticks).toEqual([5, 4]); // only initial + 1 tick
  });

  it('resume restarts after pause', () => {
    const ticks: number[] = [];
    const handle = startRestTimer({ durationSec: 5, onTick: (r) => ticks.push(r) });
    vi.advanceTimersByTime(1000);
    handle.pause();
    vi.advanceTimersByTime(1000);
    handle.resume();
    vi.advanceTimersByTime(1000);
    expect(ticks).toContain(3); // continued after resume
  });

  it('stop cancels timer, does not call onDone', () => {
    const onDone = vi.fn();
    const handle = startRestTimer({ durationSec: 3, onDone, vibrate: false, notify: false });
    vi.advanceTimersByTime(1000);
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('skip fires onDone immediately', () => {
    const onDone = vi.fn();
    const handle = startRestTimer({ durationSec: 10, onDone, vibrate: false, notify: false });
    handle.skip();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('isRunning returns false after stop', () => {
    const handle = startRestTimer({ durationSec: 5 });
    expect(handle.isRunning()).toBe(true);
    handle.stop();
    expect(handle.isRunning()).toBe(false);
  });

  it('isRunning returns false when paused', () => {
    const handle = startRestTimer({ durationSec: 5 });
    handle.pause();
    expect(handle.isRunning()).toBe(false);
  });

  it('remaining() returns current countdown value', () => {
    const handle = startRestTimer({ durationSec: 5 });
    vi.advanceTimersByTime(2000);
    expect(handle.remaining()).toBe(3);
  });

  it('clamps durationSec to minimum 1', () => {
    const ticks: number[] = [];
    startRestTimer({ durationSec: 0, onTick: (r) => ticks.push(r), vibrate: false, notify: false });
    expect(ticks[0]).toBe(1); // Math.max(1, 0) = 1
  });
});
