import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notificationsStore } from '../../apps/web/src/stores/notifications.js';

describe('notificationsStore', () => {
  let store: ReturnType<typeof notificationsStore>;
  const listeners = new Map<string, Set<EventListener>>();

  const fakeWindow = {
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatch: (type: string, detail: unknown) => {
      const event = Object.assign(new Event(type), { detail });
      listeners.get(type)?.forEach((fn) => fn(event));
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    vi.stubGlobal('window', fakeWindow);
    store = notificationsStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with empty toasts', () => {
    expect(store.toasts).toHaveLength(0);
  });

  it('push adds a toast with visible=true', () => {
    store.push({ kind: 'success', message: 'Done!' });
    expect(store.toasts).toHaveLength(1);
    expect(store.toasts[0]!.visible).toBe(true);
    expect(store.toasts[0]!.kind).toBe('success');
    expect(store.toasts[0]!.message).toBe('Done!');
  });

  it('push auto-hides after duration', () => {
    store.push({ kind: 'info', message: 'Hello', duration: 1000 });
    vi.advanceTimersByTime(1000);
    expect(store.toasts[0]!.visible).toBe(false);
    vi.advanceTimersByTime(300);
    expect(store.toasts).toHaveLength(0);
  });

  it('push uses default 3500ms duration', () => {
    store.push({ kind: 'error', message: 'Oops' });
    vi.advanceTimersByTime(3499);
    expect(store.toasts[0]!.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.toasts[0]!.visible).toBe(false);
  });

  it('dismiss hides and removes toast', () => {
    store.push({ kind: 'success', message: 'Msg' });
    const id = store.toasts[0]!.id;
    store.dismiss(id);
    expect(store.toasts[0]!.visible).toBe(false);
    vi.advanceTimersByTime(300);
    expect(store.toasts).toHaveLength(0);
  });

  it('kindClass returns correct CSS for each kind', () => {
    expect(store.kindClass('success')).toContain('bg-kinetic-neon');
    expect(store.kindClass('error')).toContain('bg-kinetic-electric');
    expect(store.kindClass('warning')).toContain('bg-kinetic-electric');
    expect(store.kindClass('info')).toContain('bg-kinetic-surface');
    expect(store.kindClass('unknown')).toContain('bg-kinetic-surface');
  });

  it('init registers kinetic:notify listener', () => {
    store.init();
    store.push = vi.fn();
    fakeWindow.dispatch('kinetic:notify', { kind: 'info', message: 'From event' });
    expect(store.push).toHaveBeenCalledWith({ kind: 'info', message: 'From event' });
  });

  it('destroy removes kinetic:notify listener', () => {
    store.init();
    store.destroy();
    expect(listeners.get('kinetic:notify')?.size ?? 0).toBe(0);
    expect(store._notifyHandler).toBeNull();
  });

  it('assigns unique IDs to each toast', () => {
    store.push({ kind: 'success', message: 'First' });
    store.push({ kind: 'success', message: 'Second' });
    const ids = store.toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('auto-hide only hides the targeted toast when multiple toasts exist (covers line 43 : t branch)', () => {
    store.push({ kind: 'success', message: 'First', duration: 1000 });
    store.push({ kind: 'info', message: 'Second', duration: 5000 });
    // Advance past First's duration — map processes both, Second hits the `: t` branch
    vi.advanceTimersByTime(1000);
    expect(store.toasts.find((t) => t.message === 'First')?.visible).toBe(false);
    expect(store.toasts.find((t) => t.message === 'Second')?.visible).toBe(true);
  });

  it('dismiss only hides the targeted toast when multiple exist (covers line 51 : t branch)', () => {
    store.push({ kind: 'success', message: 'First' });
    store.push({ kind: 'info', message: 'Second' });
    const firstId = store.toasts[0]!.id;
    // dismiss maps over both toasts — Second toast hits the `: t` branch
    store.dismiss(firstId);
    expect(store.toasts[0]!.visible).toBe(false);
    expect(store.toasts[1]!.visible).toBe(true);
  });
});
