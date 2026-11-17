import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true), getPlatform: vi.fn(() => 'android') },
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
vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));
vi.mock('../../apps/web/src/lib/training/storage.js', () => ({
  loadSessions: vi.fn(),
  loadTemplates: vi.fn(),
}));

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { getDeps } from '../../apps/web/src/deps.js';
import { loadSessions, loadTemplates } from '../../apps/web/src/lib/training/storage.js';
import {
  BACKUP_NOTIF_ID,
  DEFAULT_REMINDER_PREFS,
  ROUTINE_NOTIF_ID,
  SESSION_NOTIF_ID,
  daysSinceBackup,
  hasChosenSessionDays,
  lastBackupAt,
  nextBackupReminderAt,
  nextSessionReminderAt,
  recordBackup,
  syncBackupReminder,
  syncSessionReminder,
  WEEKLY_NOTIF_ID,
  getReminderPrefs,
  nextRoutineReminderAt,
  nextWeeklyRecapAt,
  remindersPermitted,
  requestReminderPermission,
  setReminderPrefs,
  syncRoutineReminder,
  syncWeeklyRecap,
  weeklyRecapBody,
} from '../../apps/web/src/lib/reminders.js';
import type { WeeklyReview } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';

function stubLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

const granted = { display: 'granted' } as never;
const denied = { display: 'denied' } as never;
const scheduled = () => vi.mocked(LocalNotifications.schedule).mock.calls[0]![0].notifications[0]!;

beforeEach(() => {
  stubLocalStorage();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue(granted);
  vi.mocked(LocalNotifications.cancel).mockResolvedValue(undefined);
  vi.mocked(LocalNotifications.schedule).mockResolvedValue({ notifications: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('réglages', () => {
  it('renvoie les valeurs par défaut sans réglage enregistré', () => {
    expect(getReminderPrefs()).toEqual(DEFAULT_REMINDER_PREFS);
  });

  it('enregistre un changement et le relit', () => {
    setReminderPrefs({ routine: false, routineTime: '07:30' });
    expect(getReminderPrefs()).toEqual({
      ...DEFAULT_REMINDER_PREFS,
      routine: false,
      routineTime: '07:30',
    });
  });

  it('écarte une heure invalide et un contenu corrompu', () => {
    expect(setReminderPrefs({ routineTime: '25:99' }).routineTime).toBe('20:00');
    localStorage.setItem('kinetic:reminder:prefs', '{oops');
    expect(getReminderPrefs()).toEqual(DEFAULT_REMINDER_PREFS);
    localStorage.setItem('kinetic:reminder:prefs', '{"routine":"yes","routineTime":7}');
    expect(getReminderPrefs()).toEqual(DEFAULT_REMINDER_PREFS);
  });
});

describe('nextRoutineReminderAt', () => {
  const noon = new Date(2026, 4, 16, 12, 0);

  it("vise aujourd'hui si la routine reste à faire et l'heure à venir", () => {
    expect(nextRoutineReminderAt(noon, '20:00', false)).toEqual(new Date(2026, 4, 16, 20, 0));
  });

  it("vise demain si la routine est terminée ou l'heure passée", () => {
    expect(nextRoutineReminderAt(noon, '20:00', true)).toEqual(new Date(2026, 4, 17, 20, 0));
    expect(nextRoutineReminderAt(noon, '08:15', false)).toEqual(new Date(2026, 4, 17, 8, 15));
  });

  it("retombe sur 20 h si l'heure est invalide", () => {
    expect(nextRoutineReminderAt(noon, 'bientôt', false)).toEqual(new Date(2026, 4, 16, 20, 0));
  });
});

describe('nextWeeklyRecapAt', () => {
  it('vise le dimanche 18 h de la semaine en cours', () => {
    // 2026-05-13 est un mercredi
    expect(nextWeeklyRecapAt(new Date(2026, 4, 13, 9, 0))).toEqual(new Date(2026, 4, 17, 18, 0));
    expect(nextWeeklyRecapAt(new Date(2026, 4, 17, 17, 59))).toEqual(new Date(2026, 4, 17, 18, 0));
  });

  it("passe au dimanche suivant une fois l'heure atteinte", () => {
    expect(nextWeeklyRecapAt(new Date(2026, 4, 17, 18, 0))).toEqual(new Date(2026, 4, 24, 18, 0));
  });
});

describe('weeklyRecapBody', () => {
  const review = (patch: Partial<WeeklyReview>): WeeklyReview =>
    ({ sessions: 0, tonnageKg: 0, prCount: 0, ...patch }) as WeeklyReview;

  it('résume séances, tonnage et records', () => {
    const body = weeklyRecapBody(review({ sessions: 3, tonnageKg: 12400, prCount: 2 }));
    expect(body).toContain('3 séances');
    expect(body).toContain('kg soulevés');
    expect(body).toContain('2 records');
  });

  it('accorde le singulier et omet les records absents', () => {
    const body = weeklyRecapBody(review({ sessions: 1, tonnageKg: 800 }));
    expect(body).toContain('1 séance ·');
    expect(body).not.toContain('record');
  });

  it('reste encourageant sans séance', () => {
    expect(weeklyRecapBody(review({}))).toContain('Aucune séance');
  });
});

describe('autorisation', () => {
  it('ne demande rien si elle est déjà accordée', async () => {
    expect(await requestReminderPermission()).toBe(true);
    expect(await remindersPermitted()).toBe(true);
    expect(LocalNotifications.requestPermissions).not.toHaveBeenCalled();
  });

  it('demande puis rapporte le refus', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue(denied);
    vi.mocked(LocalNotifications.requestPermissions).mockResolvedValue(denied);
    expect(await requestReminderPermission()).toBe(false);
    expect(await remindersPermitted()).toBe(false);
  });

  it('est toujours fausse sur le web et en cas de panne du plugin', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await requestReminderPermission()).toBe(false);
    expect(await remindersPermitted()).toBe(false);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(LocalNotifications.checkPermissions).mockRejectedValue(new Error('boom'));
    expect(await remindersPermitted()).toBe(false);
    vi.mocked(LocalNotifications.requestPermissions).mockRejectedValue(new Error('boom'));
    expect(await requestReminderPermission()).toBe(false);
  });
});

describe('syncRoutineReminder', () => {
  const noon = new Date(2026, 4, 16, 12, 0);

  it('programme le rappel du jour avec le nombre de tâches restantes', async () => {
    await syncRoutineReminder({ done: 2, total: 5 }, noon);

    expect(LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: ROUTINE_NOTIF_ID }],
    });
    const notif = scheduled();
    expect(notif.id).toBe(ROUTINE_NOTIF_ID);
    expect(notif.body).toContain('3 tâches');
    expect(notif.schedule?.at).toEqual(new Date(2026, 4, 16, 20, 0));
    expect(notif.extra).toEqual({ route: '/vitalite' });
  });

  it('reporte à demain quand la routine est terminée', async () => {
    await syncRoutineReminder({ done: 5, total: 5 }, noon);
    expect(scheduled().schedule?.at).toEqual(new Date(2026, 4, 17, 20, 0));
    expect(scheduled().body).not.toContain('Encore');
  });

  it("respecte l'heure choisie", async () => {
    setReminderPrefs({ routineTime: '18:30' });
    await syncRoutineReminder({ done: 4, total: 5 }, noon);
    expect(scheduled().schedule?.at).toEqual(new Date(2026, 4, 16, 18, 30));
    expect(scheduled().body).toContain('1 tâche pour');
  });

  it('annule sans reprogrammer si le rappel est désactivé, refusé ou sans routine', async () => {
    setReminderPrefs({ routine: false });
    await syncRoutineReminder({ done: 0, total: 5 }, noon);
    setReminderPrefs({ routine: true });
    await syncRoutineReminder({ done: 0, total: 0 }, noon);
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue(denied);
    await syncRoutineReminder({ done: 0, total: 5 }, noon);

    expect(LocalNotifications.cancel).toHaveBeenCalledTimes(3);
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('ne fait rien sur le web et avale les erreurs du plugin', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await syncRoutineReminder({ done: 0, total: 5 }, noon);
    expect(LocalNotifications.cancel).not.toHaveBeenCalled();

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(LocalNotifications.cancel).mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(syncRoutineReminder({ done: 0, total: 5 }, noon)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('syncWeeklyRecap', () => {
  const wednesday = new Date(2026, 4, 13, 9, 0);

  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue({ storage: new InMemoryStorage() } as never);
  });

  it('programme le bilan du dimanche avec les chiffres de la semaine', async () => {
    vi.mocked(loadSessions).mockResolvedValue([
      {
        id: 's1',
        name: 'Push',
        startedAt: '2026-05-12T18:00:00.000Z',
        entries: [
          {
            exerciseId: 'bench',
            sets: [
              { reps: 5, weightKg: 100, rpe: 8, performedAt: '2026-05-12T18:10:00.000Z' },
              { reps: 5, weightKg: 100, rpe: 9, performedAt: '2026-05-12T18:15:00.000Z' },
            ],
          },
        ],
      },
    ] as never);

    await syncWeeklyRecap(wednesday);

    const notif = scheduled();
    expect(notif.id).toBe(WEEKLY_NOTIF_ID);
    expect(notif.schedule?.at).toEqual(new Date(2026, 4, 17, 18, 0));
    expect(notif.body).toContain('1 séance');
    expect(notif.body).toContain('kg soulevés');
    expect(notif.extra).toEqual({ route: '/progression' });
  });

  it('annule sans reprogrammer si le bilan est désactivé', async () => {
    setReminderPrefs({ weekly: false });
    await syncWeeklyRecap(wednesday);
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: WEEKLY_NOTIF_ID }],
    });
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('ne fait rien sur le web et avale les erreurs de lecture', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await syncWeeklyRecap(wednesday);
    expect(LocalNotifications.cancel).not.toHaveBeenCalled();

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(loadSessions).mockRejectedValue(new Error('IDB'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(syncWeeklyRecap(wednesday)).resolves.toBeUndefined();
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('jours de séance', () => {
  it('lit, trie et dédoublonne les jours choisis', () => {
    expect(hasChosenSessionDays()).toBe(false);
    setReminderPrefs({ sessionDays: [5, 1, 5, 3] });
    expect(getReminderPrefs().sessionDays).toEqual([1, 3, 5]);
    expect(hasChosenSessionDays()).toBe(true);
  });

  it('ignore une liste invalide', () => {
    localStorage.setItem('kinetic:reminder:prefs', '{"sessionDays":[1,9],"sessionTime":"x"}');
    expect(getReminderPrefs().sessionDays).toEqual(DEFAULT_REMINDER_PREFS.sessionDays);
    expect(getReminderPrefs().sessionTime).toBe('18:00');
    expect(hasChosenSessionDays()).toBe(false);
  });
});

describe('nextSessionReminderAt', () => {
  // 2026-05-13 est un mercredi
  const wedNoon = new Date(2026, 4, 13, 12, 0);

  it("vise aujourd'hui si c'est un jour choisi et l'heure à venir", () => {
    expect(nextSessionReminderAt(wedNoon, '18:00', [1, 3, 5], false)).toEqual(
      new Date(2026, 4, 13, 18, 0),
    );
  });

  it("passe au jour choisi suivant si la séance du jour est faite ou l'heure passée", () => {
    expect(nextSessionReminderAt(wedNoon, '18:00', [1, 3, 5], true)).toEqual(
      new Date(2026, 4, 15, 18, 0),
    );
    expect(nextSessionReminderAt(wedNoon, '07:00', [3], false)).toEqual(
      new Date(2026, 4, 20, 7, 0),
    );
  });

  it('renvoie null sans jour choisi', () => {
    expect(nextSessionReminderAt(wedNoon, '18:00', [], false)).toBeNull();
  });
});

describe('sauvegarde', () => {
  it('note la date et calcule les jours écoulés', () => {
    const now = new Date(2026, 4, 20, 12, 0);
    expect(lastBackupAt()).toBeNull();
    expect(daysSinceBackup(now)).toBe(0);
    expect(daysSinceBackup(new Date(2026, 4, 25, 12, 0))).toBe(5);
    recordBackup(new Date(2026, 4, 24, 12, 0));
    expect(lastBackupAt()).toEqual(new Date(2026, 4, 24, 12, 0));
    expect(daysSinceBackup(new Date(2026, 4, 25, 12, 0))).toBe(1);
  });

  it('vise 30 jours après la dernière sauvegarde, à 19 h', () => {
    const last = new Date(2026, 4, 1, 10, 0).getTime();
    expect(nextBackupReminderAt(new Date(2026, 4, 2), last)).toEqual(new Date(2026, 4, 31, 19, 0));
  });

  it('en retard : le soir même, ou le lendemain si 19 h est passé', () => {
    const last = new Date(2026, 0, 1).getTime();
    expect(nextBackupReminderAt(new Date(2026, 4, 2, 9, 0), last)).toEqual(
      new Date(2026, 4, 2, 19, 0),
    );
    expect(nextBackupReminderAt(new Date(2026, 4, 2, 20, 0), last)).toEqual(
      new Date(2026, 4, 3, 19, 0),
    );
  });
});

describe('syncSessionReminder', () => {
  const wedNoon = new Date(2026, 4, 13, 12, 0);
  const templates = [
    {
      id: 'tpl-push-a',
      name: 'Push A',
      createdAt: '2026-01-01T00:00:00.000Z',
      exercises: [{ exerciseId: 'bench', sets: 3, targetReps: 8, targetRpe: 8 }],
    },
  ];

  beforeEach(() => {
    vi.mocked(getDeps).mockResolvedValue({ storage: new InMemoryStorage() } as never);
    vi.mocked(loadTemplates).mockResolvedValue(templates as never);
  });

  it('programme le rappel du jour avec la prochaine séance', async () => {
    vi.mocked(loadSessions).mockResolvedValue([]);
    await syncSessionReminder(wedNoon);
    const notif = scheduled();
    expect(notif.id).toBe(SESSION_NOTIF_ID);
    expect(notif.schedule?.at).toEqual(new Date(2026, 4, 13, 18, 0));
    expect(notif.body).toContain('Push A');
    expect(notif.extra).toEqual({ route: '/seances' });
  });

  it("saute aujourd'hui quand une séance est déjà enregistrée", async () => {
    vi.mocked(loadSessions).mockResolvedValue([
      {
        id: 's1',
        name: 'Push A',
        templateId: 'tpl-push-a',
        startedAt: new Date(2026, 4, 13, 8, 0).toISOString(),
        endedAt: new Date(2026, 4, 13, 9, 0).toISOString(),
        entries: [{ exerciseId: 'bench', sets: [{ reps: 5, weightKg: 80, performedAt: '' }] }],
      },
    ] as never);
    await syncSessionReminder(wedNoon);
    expect(scheduled().schedule?.at).toEqual(new Date(2026, 4, 15, 18, 0));
  });

  it('annule sans reprogrammer si désactivé', async () => {
    setReminderPrefs({ session: false });
    await syncSessionReminder(wedNoon);
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: SESSION_NOTIF_ID }],
    });
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('avale les erreurs de lecture', async () => {
    vi.mocked(loadSessions).mockRejectedValue(new Error('IDB'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(syncSessionReminder(wedNoon)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('syncBackupReminder', () => {
  it('ne rappelle rien quand un compte synchronise les données', async () => {
    await syncBackupReminder(true, new Date(2026, 4, 2));
    expect(LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: BACKUP_NOTIF_ID }],
    });
    expect(LocalNotifications.schedule).not.toHaveBeenCalled();
  });

  it('programme le rappel 30 jours après le premier lancement', async () => {
    await syncBackupReminder(false, new Date(2026, 4, 2, 10, 0));
    const notif = scheduled();
    expect(notif.id).toBe(BACKUP_NOTIF_ID);
    expect(notif.schedule?.at).toEqual(new Date(2026, 5, 1, 19, 0));
    expect(notif.extra).toEqual({ route: '/profile' });
  });

  it('une fois le rappel en retard passé, le suivant revient 30 jours plus tard', async () => {
    recordBackup(new Date(2026, 0, 1));
    await syncBackupReminder(false, new Date(2026, 4, 2, 10, 0));
    expect(scheduled().schedule?.at).toEqual(new Date(2026, 4, 2, 19, 0));

    vi.mocked(LocalNotifications.schedule).mockClear();
    await syncBackupReminder(false, new Date(2026, 4, 3, 10, 0));
    expect(scheduled().schedule?.at).toEqual(new Date(2026, 5, 1, 19, 0));
  });

  it('ne fait rien sur le web', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await syncBackupReminder(false);
    expect(LocalNotifications.cancel).not.toHaveBeenCalled();
  });
});
