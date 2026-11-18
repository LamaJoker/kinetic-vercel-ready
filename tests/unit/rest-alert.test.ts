import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'ios') },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
  },
}));

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  REST_NOTIF_ID,
  cancelRestAlert,
  restAlertContent,
  scheduleRestAlert,
} from '../../apps/web/src/lib/training/rest-alert.js';

const ln = LocalNotifications as unknown as Record<string, ReturnType<typeof vi.fn>>;
let store: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
  });
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  ln.checkPermissions!.mockResolvedValue({ display: 'granted' });
  ln.requestPermissions!.mockResolvedValue({ display: 'granted' });
});

describe('alerte de fin de repos (notification locale)', () => {
  it('texte : exercice et série suivante', () => {
    expect(restAlertContent('Squat')).toEqual({
      title: 'Repos terminé · Squat',
      body: 'Série suivante',
    });
    expect(restAlertContent('').title).toBe('Repos terminé');
  });

  it("programme l'alerte à l'heure de fin avec l'id réservé (hors 1001-1004)", async () => {
    const at = Date.now() + 90_000;
    await scheduleRestAlert(at, 'Squat');
    expect(REST_NOTIF_ID).toBe(1005);
    const n = ln.schedule!.mock.calls[0]![0].notifications[0];
    expect(n.id).toBe(1005);
    expect(n.title).toBe('Repos terminé · Squat');
    expect(n.schedule.at.getTime()).toBe(at);
  });

  it('demande la permission une seule fois', async () => {
    ln.checkPermissions!.mockResolvedValue({ display: 'prompt' });
    ln.requestPermissions!.mockResolvedValue({ display: 'denied' });
    await scheduleRestAlert(Date.now() + 60_000, 'Squat');
    await scheduleRestAlert(Date.now() + 60_000, 'Squat');
    expect(ln.requestPermissions).toHaveBeenCalledTimes(1);
    expect(ln.schedule).not.toHaveBeenCalled();
  });

  it('une annulation pendant la demande de permission gagne', async () => {
    ln.checkPermissions!.mockResolvedValue({ display: 'prompt' });
    let grant: (v: { display: string }) => void = () => {};
    ln.requestPermissions!.mockReturnValue(new Promise((r) => (grant = r)));
    const pending = scheduleRestAlert(Date.now() + 60_000, 'Squat');
    await new Promise((r) => setTimeout(r, 0));
    await cancelRestAlert();
    grant({ display: 'granted' });
    await pending;
    expect(ln.schedule).not.toHaveBeenCalled();
    expect(ln.cancel).toHaveBeenCalledWith({ notifications: [{ id: 1005 }] });
  });

  it('repos déjà passé, ou web : rien', async () => {
    await scheduleRestAlert(Date.now() - 1, 'Squat');
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await scheduleRestAlert(Date.now() + 60_000, 'Squat');
    await cancelRestAlert();
    expect(ln.schedule).not.toHaveBeenCalled();
    expect(ln.cancel).not.toHaveBeenCalled();
  });
});
