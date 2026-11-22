import { describe, it, expect } from 'vitest';
import {
  DEEP_LINK_PREFIX,
  createDeepLinkGate,
  deepLinkRoute,
  firstLaunchUrl,
  parseDeepLink,
  shortcutUrl,
} from '../../apps/web/src/lib/deep-link.js';
import { SHORTCUTS, waterShortcutMessage } from '../../apps/web/src/lib/shortcut-list.js';

describe('parseDeepLink', () => {
  it('ouvre une page simple sans action', () => {
    expect(parseDeepLink('com.lamajoker.kinetic://open/vitalite')).toEqual({
      route: '/vitalite',
      action: null,
    });
  });

  it('reconnaît les actions des raccourcis', () => {
    expect(parseDeepLink(shortcutUrl('seance-du-jour'))).toEqual({
      route: '/seances',
      action: 'start-today',
    });
    expect(parseDeepLink(shortcutUrl('pesee'))).toEqual({
      route: '/bodyweight',
      action: 'log-weight',
    });
    expect(parseDeepLink(shortcutUrl('eau'))).toEqual({ route: '/', action: 'add-water' });
    expect(parseDeepLink(shortcutUrl('checkin'))).toEqual({ route: '/', action: 'checkin' });
    expect(parseDeepLink(shortcutUrl('minuteurs'))).toEqual({
      route: '/minuteurs',
      action: null,
    });
  });

  it('ignore les paramètres et le fragment', () => {
    expect(parseDeepLink('com.lamajoker.kinetic://open/eau?source=siri#x')).toEqual({
      route: '/',
      action: 'add-water',
    });
  });

  it('ne confond pas une page avec une propriété héritée', () => {
    expect(parseDeepLink('com.lamajoker.kinetic://open/constructor')).toEqual({
      route: '/constructor',
      action: null,
    });
  });

  it("renvoie l'accueil sans action pour une page invalide", () => {
    expect(parseDeepLink('com.lamajoker.kinetic://open/../eau')).toEqual({
      route: '/',
      action: null,
    });
    expect(parseDeepLink('com.lamajoker.kinetic://open/EAU')).toEqual({ route: '/', action: null });
  });

  it('ignore le retour de connexion et les liens externes', () => {
    expect(parseDeepLink('com.lamajoker.kinetic://auth-callback#access_token=x')).toBeNull();
    expect(parseDeepLink('https://example.com/open/eau')).toBeNull();
  });

  it('deepLinkRoute donne la page du raccourci', () => {
    expect(deepLinkRoute(shortcutUrl('pesee'))).toBe('/bodyweight');
    expect(deepLinkRoute('https://example.com')).toBeNull();
  });
});

describe('SHORTCUTS', () => {
  it('a des liens uniques et valides', () => {
    const slugs = SHORTCUTS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of SHORTCUTS) {
      expect(shortcutUrl(s.slug).startsWith(DEEP_LINK_PREFIX)).toBe(true);
      expect(s.url).toBe(shortcutUrl(s.slug));
      expect(parseDeepLink(s.url)).toEqual({ route: s.route, action: s.action });
      expect(s.title.length).toBeGreaterThan(0);
    }
  });

  it('couvre les raccourcis natifs (Android shortcuts.xml, Info.plist iOS)', () => {
    expect(SHORTCUTS.map((s) => s.slug)).toEqual(
      expect.arrayContaining(['seance-du-jour', 'pesee', 'eau', 'checkin', 'minuteurs']),
    );
  });
});

describe('createDeepLinkGate', () => {
  it('ne traite pas deux fois le même lien coup sur coup', () => {
    let t = 1000;
    const gate = createDeepLinkGate(3000, () => t);
    expect(gate('a')).toBe(true);
    t += 500;
    expect(gate('a')).toBe(false);
    expect(gate('b')).toBe(true);
    t += 100;
    expect(gate('a')).toBe(true);
  });

  it('accepte à nouveau le même lien après le délai', () => {
    let t = 0;
    const gate = createDeepLinkGate(3000, () => t);
    expect(gate('a')).toBe(true);
    t = 3000;
    expect(gate('a')).toBe(true);
  });
});

describe('firstLaunchUrl', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it('ne rejoue pas le lien de lancement après un rechargement', () => {
    const m = memory();
    expect(firstLaunchUrl(shortcutUrl('eau'), m)).toBe(true);
    expect(firstLaunchUrl(shortcutUrl('eau'), m)).toBe(false);
    expect(firstLaunchUrl(shortcutUrl('pesee'), m)).toBe(true);
  });

  it('traite le lien sans mémoire de session', () => {
    expect(firstLaunchUrl('x', null)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('bloqué');
      },
      setItem: () => undefined,
    };
    expect(firstLaunchUrl('x', broken)).toBe(true);
  });
});

describe('waterShortcutMessage', () => {
  it("indique l'avancement", () => {
    expect(waterShortcutMessage('250 ml', '1,25 L', '2 L', false)).toBe(
      'Verre ajouté (250 ml) : 1,25 L sur 2 L aujourd’hui.',
    );
  });

  it("célèbre l'objectif atteint", () => {
    expect(waterShortcutMessage('250 ml', '2 L', '2 L', true)).toBe(
      'Verre ajouté (250 ml) : objectif atteint, 2 L aujourd’hui.',
    );
  });
});
