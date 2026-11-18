import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false), getPlatform: vi.fn(() => 'web') },
}));

import {
  navDirection,
  isRootTab,
  readHistoryIdx,
  forceNextDirection,
  takeForcedDirection,
  setHistoryIdx,
  currentHistoryIdx,
} from '../../apps/web/src/lib/nav-motion.js';
import {
  lockAxis,
  shouldCommitBack,
  rubberBand,
  isRefreshable,
  edgeSwipeSupported,
  refreshCurrentPage,
  REFRESH_EVENT,
  PTR_LIMIT_PX,
  PTR_THRESHOLD_PX,
} from '../../apps/web/src/lib/native-gestures.js';

describe('navDirection (transitions façon iOS)', () => {
  it('aucune animation au premier rendu ou vers la même page', () => {
    expect(navDirection('/', '/records', 'initial')).toBe('none');
    expect(navDirection('/records', '/records', 'push')).toBe('none');
  });

  it('entre onglets racines : fondu', () => {
    expect(navDirection('/', '/seances', 'push')).toBe('tab');
    expect(navDirection('/profile', '/vitalite', 'pop', 3, 2)).toBe('tab');
    expect(navDirection('/bodyweight', '/mensurations', 'push')).toBe('tab');
  });

  it('vers une sous-page : glissé avant', () => {
    expect(navDirection('/profile', '/records', 'push')).toBe('forward');
    expect(navDirection('/records', '/plates', 'push')).toBe('forward');
  });

  it("depuis une sous-page vers un onglet de la barre : fondu (changement d'onglet)", () => {
    expect(navDirection('/records', '/seances', 'push')).toBe('tab');
  });

  it("popstate : sens déduit de l'index d'historique", () => {
    expect(navDirection('/records', '/profile', 'pop', 2, 1)).toBe('back');
    expect(navDirection('/profile', '/records', 'pop', 1, 2)).toBe('forward');
    expect(navDirection('/records', '/plates', 'pop', null, 1)).toBe('tab');
  });

  it('remplacement et écrans plein cadre : fondu', () => {
    expect(navDirection('/records', '/plates', 'replace')).toBe('tab');
    expect(navDirection('/', '/onboarding', 'push')).toBe('tab');
    expect(navDirection('/login', '/records', 'push')).toBe('tab');
  });

  it('ignore la query string et le slash final', () => {
    expect(isRootTab('/seances?x=1')).toBe(true);
    expect(isRootTab('/profile/')).toBe(true);
    expect(isRootTab('/records')).toBe(false);
  });
});

describe('état partagé routeur ↔ gestes', () => {
  it('readHistoryIdx lit kIdx numérique seulement', () => {
    expect(readHistoryIdx({ kIdx: 3 })).toBe(3);
    expect(readHistoryIdx({ kIdx: '3' })).toBeNull();
    expect(readHistoryIdx(null)).toBeNull();
    expect(readHistoryIdx({})).toBeNull();
  });

  it('le sens imposé par le geste est consommé une seule fois', () => {
    forceNextDirection('swipe');
    expect(takeForcedDirection()).toBe('swipe');
    expect(takeForcedDirection()).toBeNull();
  });

  it("mémorise l'index d'historique", () => {
    setHistoryIdx(4);
    expect(currentHistoryIdx()).toBe(4);
    setHistoryIdx(0);
  });
});

describe('gestes : logique pure', () => {
  it('lockAxis attend la zone morte puis prend l’axe dominant', () => {
    expect(lockAxis(4, 3)).toBeNull();
    expect(lockAxis(14, 3)).toBe('x');
    expect(lockAxis(6, -12)).toBe('y');
    // diagonale à 45° : le défilement vertical l'emporte
    expect(lockAxis(12, 12)).toBe('y');
  });

  it('shouldCommitBack : un tiers de largeur ou lancé rapide', () => {
    expect(shouldCommitBack(130, 0, 390)).toBe(true);
    expect(shouldCommitBack(100, 0.1, 390)).toBe(false);
    expect(shouldCommitBack(60, 0.8, 390)).toBe(true);
    expect(shouldCommitBack(10, 2, 390)).toBe(false); // trop court même rapide
    expect(shouldCommitBack(-50, 2, 390)).toBe(false);
  });

  it('rubberBand : monotone, plafonné, nul pour une traction négative', () => {
    expect(rubberBand(-10)).toBe(0);
    const a = rubberBand(50);
    const b = rubberBand(150);
    const c = rubberBand(5000);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeLessThan(PTR_LIMIT_PX);
    expect(b - a).toBeLessThan(100); // freine
    // le seuil est atteignable avec une traction raisonnable
    expect(rubberBand(220)).toBeGreaterThanOrEqual(PTR_THRESHOLD_PX);
  });

  it('isRefreshable : écrans principaux seulement', () => {
    for (const p of ['/', '/seances', '/vitalite', '/nutrition', '/profile']) {
      expect(isRefreshable(p)).toBe(true);
    }
    expect(isRefreshable('/records')).toBe(false);
    expect(isRefreshable('/onboarding')).toBe(false);
  });

  it('edgeSwipeSupported : iOS natif ou web iOS installé, jamais Android', () => {
    expect(edgeSwipeSupported({ native: true, platform: 'ios', standalone: false })).toBe(true);
    expect(edgeSwipeSupported({ native: true, platform: 'android', standalone: false })).toBe(
      false,
    );
    expect(edgeSwipeSupported({ native: false, platform: 'web', standalone: true })).toBe(true);
    expect(edgeSwipeSupported({ native: false, platform: 'web', standalone: false })).toBe(false);
  });
});

describe('refreshCurrentPage', () => {
  const events: string[] = [];
  let outletChild: unknown;

  beforeEach(() => {
    events.length = 0;
    outletChild = null;
    vi.stubGlobal('window', {
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      Alpine: undefined as unknown,
    });
    vi.stubGlobal(
      'CustomEvent',
      class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    );
    vi.stubGlobal('document', {
      getElementById: () => ({ querySelector: () => outletChild }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('émet l’événement, relit les stores et appelle refresh() de la page', async () => {
    const xp = { reload: vi.fn().mockResolvedValue(undefined) };
    const vitalite = { init: vi.fn().mockResolvedValue(undefined) };
    (window as unknown as { Alpine: unknown }).Alpine = {
      store: (n: string) => (n === 'xp' ? xp : n === 'vitalite' ? vitalite : undefined),
    };
    const page = { refresh: vi.fn().mockResolvedValue(undefined), init: vi.fn() };
    outletChild = { _x_dataStack: [page] };

    await refreshCurrentPage();

    expect(events).toEqual([REFRESH_EVENT]);
    expect(xp.reload).toHaveBeenCalledTimes(1);
    expect(vitalite.init).toHaveBeenCalledTimes(1);
    expect(page.refresh).toHaveBeenCalledTimes(1);
    expect(page.init).not.toHaveBeenCalled();
  });

  it('à défaut de refresh(), rappelle init() avec le bon this', async () => {
    const page = {
      seen: null as unknown,
      init(this: { seen: unknown }) {
        this.seen = this;
      },
    };
    outletChild = { _x_dataStack: [page] };
    await refreshCurrentPage();
    expect(page.seen).toBe(page);
  });

  it('ne lève jamais, même si la page échoue', async () => {
    outletChild = {
      _x_dataStack: [{ refresh: () => Promise.reject(new Error('boom')) }],
    };
    await expect(refreshCurrentPage()).resolves.toBeUndefined();
  });
});
