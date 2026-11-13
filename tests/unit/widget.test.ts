import { describe, it, expect, vi, beforeEach } from 'vitest';

const { update, canPin, requestPin } = vi.hoisted(() => ({
  update: vi.fn(),
  canPin: vi.fn(),
  requestPin: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'android'),
  },
  registerPlugin: vi.fn(() => ({ update, canPin, requestPin })),
}));
vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn() }));

import { Capacitor } from '@capacitor/core';
import { getDeps } from '../../apps/web/src/deps.js';
import {
  buildWidgetSnapshot,
  canPinWidget,
  localIsoDate,
  requestPinWidget,
  syncWidget,
} from '../../apps/web/src/lib/widget.js';
import { deepLinkRoute } from '../../apps/web/src/lib/deep-link.js';
import { InMemoryStorage } from '../helpers/stubs.js';

describe('buildWidgetSnapshot', () => {
  it('reprend la série et borne la progression', () => {
    expect(
      buildWidgetSnapshot(
        { count: 12, best: 20, lastActiveDate: '2026-05-16' },
        { done: 9, total: 6 },
        '2026-05-16',
      ),
    ).toEqual({ streak: 12, lastActiveDate: '2026-05-16', done: 6, total: 6, date: '2026-05-16' });
  });

  it("donne un état vide quand il n'y a pas encore de série", () => {
    expect(buildWidgetSnapshot(null, { done: -1, total: 0 }, '2026-05-16')).toEqual({
      streak: 0,
      lastActiveDate: '',
      done: 0,
      total: 0,
      date: '2026-05-16',
    });
  });
});

describe('localIsoDate', () => {
  it('formate la date locale en AAAA-MM-JJ', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('deepLinkRoute', () => {
  it('reconnaît les liens du widget', () => {
    expect(deepLinkRoute('com.lamajoker.kinetic://open/vitalite')).toBe('/vitalite');
    expect(deepLinkRoute('com.lamajoker.kinetic://open/progression?x=1')).toBe('/progression');
  });

  it("renvoie l'accueil pour une page invalide", () => {
    expect(deepLinkRoute('com.lamajoker.kinetic://open/')).toBe('/');
    expect(deepLinkRoute('com.lamajoker.kinetic://open/../etc')).toBe('/');
  });

  it('ignore le retour de connexion et les autres liens', () => {
    expect(deepLinkRoute('com.lamajoker.kinetic://auth-callback#access_token=x')).toBeNull();
    expect(deepLinkRoute('https://example.com/open/vitalite')).toBeNull();
  });
});

describe('syncWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue(undefined);
    canPin.mockResolvedValue({ supported: true });
    requestPin.mockResolvedValue({ requested: true });
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
  });

  it('ne fait rien sur le web', async () => {
    await syncWidget({ done: 1, total: 3 });
    expect(update).not.toHaveBeenCalled();
    expect(await canPinWidget()).toBe(false);
    expect(await requestPinWidget()).toBe(false);
  });

  it('pousse la série et la routine vers le widget Android', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const storage = new InMemoryStorage();
    await storage.set('kinetic:streak', { count: 4, best: 9, lastActiveDate: '2026-05-15' });
    vi.mocked(getDeps).mockResolvedValue({ storage } as never);

    await syncWidget({ done: 2, total: 5 });

    expect(update).toHaveBeenCalledWith({
      streak: 4,
      lastActiveDate: '2026-05-15',
      done: 2,
      total: 5,
      date: localIsoDate(),
    });
    expect(await canPinWidget()).toBe(true);
    expect(await requestPinWidget()).toBe(true);
  });

  it("n'échoue pas si le plugin natif est absent", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(getDeps).mockResolvedValue({ storage: new InMemoryStorage() } as never);
    update.mockRejectedValueOnce(new Error('not implemented'));
    canPin.mockRejectedValueOnce(new Error('not implemented'));
    requestPin.mockRejectedValueOnce(new Error('not implemented'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(syncWidget({ done: 0, total: 1 })).resolves.toBeUndefined();
    expect(await canPinWidget()).toBe(false);
    expect(await requestPinWidget()).toBe(false);
    warn.mockRestore();
  });
});
