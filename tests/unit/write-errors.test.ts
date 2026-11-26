/**
 * Échecs d'écriture sur des données de l'utilisateur (audit qualité QA-08) : signalés à
 * l'utilisateur (notification) et, pour une mise à jour optimiste, l'écran revient à la
 * valeur réellement enregistrée.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';

const store = new Map<string, unknown>();
let failWrites = false;
const storage = {
  get: vi.fn(async (k: string) => (store.has(k) ? structuredClone(store.get(k)) : null)),
  set: vi.fn(async (k: string, v: unknown) => {
    if (failWrites) throw new DOMException('quota', 'QuotaExceededError');
    store.set(k, structuredClone(v));
  }),
  remove: vi.fn(async (k: string) => void store.delete(k)),
  keys: vi.fn(async () => [...store.keys()]),
};
vi.mock('../../apps/web/src/deps', () => ({ getDeps: async () => ({ storage }) }));
vi.mock('../../apps/web/src/lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticMedium: vi.fn(),
  hapticHeavy: vi.fn(),
  hapticSuccess: vi.fn(),
  hapticTap: vi.fn(),
}));

const { notifyWriteFailed, writeFailedMessage } =
  await import('../../apps/web/src/lib/write-errors.js');
const { programsPage } = await import('../../apps/web/src/pages/programs.page.js');
const { timersPage } = await import('../../apps/web/src/pages/timers.page.js');
const { nutritionStore } = await import('../../apps/web/src/stores/nutrition.js');

const notices: Array<{ kind: string; message: string }> = [];

beforeEach(() => {
  store.clear();
  failWrites = false;
  notices.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('window', {
    location: { search: '' },
    dispatchEvent: (e: CustomEvent) => {
      if (e.type === STORAGE_KEYS.EVENT_NOTIFY) notices.push(e.detail);
      return true;
    },
  });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('navigator', {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('notifyWriteFailed', () => {
  it('journalise ET affiche une erreur compréhensible', () => {
    notifyWriteFailed('ton 1RM', new Error('quota'));
    expect(notices).toEqual([{ kind: 'error', message: writeFailedMessage('ton 1RM') }]);
    expect(writeFailedMessage('ton 1RM')).toBe(
      'Impossible d’enregistrer ton 1RM (stockage plein ?). Réessaie.',
    );
    expect(console.error).toHaveBeenCalled();
  });
});

describe('Programmes : 1RM', () => {
  it('écriture refusée : la valeur affichée revient à celle enregistrée, et l utilisateur est prévenu', async () => {
    const page = programsPage();
    await page.setOneRm('squat', '140');
    expect(store.get(STORAGE_KEYS.PROGRAM_ONE_RMS)).toEqual({ squat: 140 });

    failWrites = true;
    await page.setOneRm('squat', '150');
    expect(page.oneRms).toEqual({ squat: 140 });
    expect(notices).toEqual([{ kind: 'error', message: writeFailedMessage('ton 1RM') }]);
  });
});

describe('Minuteurs : préréglages', () => {
  it('enregistrement refusé : notification (plus seulement console.warn)', async () => {
    const page = timersPage();
    failWrites = true;
    await page._savePresets();
    expect(notices).toEqual([
      { kind: 'error', message: writeFailedMessage('tes préréglages de minuteur') },
    ]);
  });
});

describe('Nutrition : plan recalculé', () => {
  it('enregistrement refusé : l utilisateur est prévenu', async () => {
    store.set(STORAGE_KEYS.USER_PROFILE, {
      sex: 'male',
      ageYears: 30,
      heightCm: 180,
      weightKg: 80,
      bodyFatPct: null,
      activity: 'moderate',
      goal: 'maintain',
    });
    failWrites = true;
    await nutritionStore().recalculatePlan();
    expect(notices).toEqual([
      { kind: 'error', message: writeFailedMessage('ton plan nutritionnel') },
    ]);
  });
});
