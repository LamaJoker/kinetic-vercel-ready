import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { getIcon, setIcon, isNative } = vi.hoisted(() => ({
  getIcon: vi.fn(),
  setIcon: vi.fn(),
  isNative: vi.fn(() => true),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: isNative, getPlatform: vi.fn(() => 'ios') },
  registerPlugin: vi.fn(() => ({ getIcon, setIcon })),
}));

import {
  APP_ICONS,
  DEFAULT_APP_ICON,
  appIconChangedMessage,
  currentAppIcon,
  isAppIconId,
  normalizeAppIcon,
  setAppIcon,
} from '../../apps/web/src/lib/app-icon.js';

const NATIVE = resolve(__dirname, '../../apps/web');

describe('choix de l’icône', () => {
  it('propose Corail (par défaut), Nuit et Minimaliste', () => {
    expect(APP_ICONS.map((i) => i.id)).toEqual(['corail', 'nuit', 'minimal']);
    expect(DEFAULT_APP_ICON).toBe('corail');
  });

  it('valide les identifiants', () => {
    expect(isAppIconId('nuit')).toBe(true);
    expect(isAppIconId('gold')).toBe(false);
    expect(normalizeAppIcon('minimal')).toBe('minimal');
    expect(normalizeAppIcon(undefined)).toBe('corail');
    expect(normalizeAppIcon('AppIcon-Nuit')).toBe('corail');
  });

  it('prévient sur Android que le lanceur peut tarder', () => {
    expect(appIconChangedMessage('nuit', 'android')).toContain('« Nuit »');
    expect(appIconChangedMessage('nuit', 'android')).toContain('lanceur');
    expect(appIconChangedMessage('minimal', 'ios')).toBe('Icône « Minimaliste » choisie.');
  });
});

describe('pont natif KineticIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNative.mockReturnValue(true);
  });

  it("lit l'icône actuelle", async () => {
    getIcon.mockResolvedValue({ icon: 'nuit', supported: true });
    expect(await currentAppIcon()).toBe('nuit');
  });

  it('renvoie null hors application native ou sans prise en charge', async () => {
    isNative.mockReturnValue(false);
    expect(await currentAppIcon()).toBeNull();
    expect(getIcon).not.toHaveBeenCalled();
    isNative.mockReturnValue(true);
    getIcon.mockResolvedValue({ icon: 'corail', supported: false });
    expect(await currentAppIcon()).toBeNull();
    getIcon.mockRejectedValue(new Error('plugin absent'));
    expect(await currentAppIcon()).toBeNull();
  });

  it("change l'icône", async () => {
    setIcon.mockResolvedValue({ icon: 'minimal' });
    expect(await setAppIcon('minimal')).toBe('minimal');
    expect(setIcon).toHaveBeenCalledWith({ icon: 'minimal' });
  });

  it('propage le refus du système', async () => {
    setIcon.mockRejectedValue(new Error('refus'));
    await expect(setAppIcon('nuit')).rejects.toThrow('refus');
  });
});

describe('cohérence avec les projets natifs', () => {
  const read = (p: string): string => readFileSync(resolve(NATIVE, p), 'utf8');

  it('Android : un alias de lanceur par icône, Corail activé par défaut', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const plugin = read('android/app/src/main/java/com/lamajoker/kinetic/KineticIconPlugin.java');
    for (const alias of ['IconCorail', 'IconNuit', 'IconMinimal']) {
      expect(manifest).toContain(`android:name=".${alias}"`);
      expect(plugin).toContain(`"${alias}"`);
    }
    expect(manifest).toMatch(/\.IconCorail"[\s\S]*?android:enabled="true"/);
    for (const { id } of APP_ICONS) expect(plugin).toContain(`"${id}"`);
  });

  it('iOS : icônes alternatives déclarées et connues du plugin', () => {
    const project = read('ios/App/App.xcodeproj/project.pbxproj');
    const delegate = read('ios/App/App/AppDelegate.swift');
    expect(project).toContain(
      'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "AppIcon-Nuit AppIcon-Minimal"',
    );
    expect(delegate).toContain('"nuit": "AppIcon-Nuit"');
    expect(delegate).toContain('"minimal": "AppIcon-Minimal"');
    for (const set of ['AppIcon-Nuit', 'AppIcon-Minimal']) {
      const contents = JSON.parse(
        read(`ios/App/App/Assets.xcassets/${set}.appiconset/Contents.json`),
      );
      expect(contents.images[0].size).toBe('1024x1024');
    }
  });

  it('raccourcis natifs alignés sur les liens internes', () => {
    const shortcuts = read('android/app/src/main/res/xml/shortcuts.xml');
    const plist = read('ios/App/App/Info.plist');
    for (const slug of ['seance-du-jour', 'pesee', 'eau', 'checkin']) {
      expect(shortcuts).toContain(`com.lamajoker.kinetic://open/${slug}`);
      expect(plist).toContain(`com.lamajoker.kinetic.shortcut.${slug}`);
    }
  });
});
