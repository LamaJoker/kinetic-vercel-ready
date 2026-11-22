import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  applyTextSize,
  getTextSizePref,
  isAppleTouchDevice,
  readAppleBodyPx,
  setTextSizePref,
} from '../../apps/web/src/lib/text-size';

const store: Record<string, string> = {};
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = String(v);
  },
  removeItem: (k: string) => {
    delete store[k];
  },
} as Storage;

const root = { style: { fontSize: '' }, dataset: {} as Record<string, string> };
(globalThis as Record<string, unknown>).document = { documentElement: root, body: null };

afterEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  root.style.fontSize = '';
  root.dataset = {};
});

describe('isAppleTouchDevice', () => {
  it('reconnaît iPhone et iPad (y compris iPadOS qui se dit Macintosh)', () => {
    expect(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
    expect(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });
  it('exclut Mac et Android', () => {
    expect(
      isAppleTouchDevice({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(
      isAppleTouchDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', maxTouchPoints: 5 }),
    ).toBe(false);
  });
});

describe('réglage « Taille du texte »', () => {
  it('vaut « Système » par défaut', () => {
    expect(getTextSizePref()).toBe('system');
  });
  it('sans DOM complet, pas de mesure Dynamic Type', () => {
    expect(readAppleBodyPx()).toBeNull();
  });
  it('Système hors iPhone : aucune surcharge de la taille de base', () => {
    applyTextSize('system');
    expect(root.style.fontSize).toBe('');
    expect(root.dataset.textSize).toBe('n');
  });
  it('mémorise et applique Très grand (125 %)', () => {
    setTextSizePref('xlarge');
    expect(store[STORAGE_KEYS.TEXT_SIZE]).toBe('xlarge');
    expect(getTextSizePref()).toBe('xlarge');
    expect(root.style.fontSize).toBe('125%');
    expect(root.dataset.textSize).toBe('xl');
  });
  it('Grand : 112,5 %, repère « l » pour les ajustements CSS', () => {
    setTextSizePref('large');
    expect(root.style.fontSize).toBe('112.5%');
    expect(root.dataset.textSize).toBe('l');
  });
  it('ignore une valeur stockée invalide', () => {
    store[STORAGE_KEYS.TEXT_SIZE] = 'géant';
    expect(getTextSizePref()).toBe('system');
  });
});
