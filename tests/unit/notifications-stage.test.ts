/**
 * Mode salle : les notifications sont raccourcies et affichées sous l'en-tête
 * de l'écran plein format (texte fourni par stageToast()).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  notificationsStore,
  toastDuration,
  STAGE_TOAST_MS,
  TOAST_MS,
} from '../../apps/web/src/stores/notifications.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('toastDuration', () => {
  it('hors mode salle : durée demandée ou par défaut', () => {
    expect(toastDuration({ kind: 'success' }, false)).toBe(TOAST_MS);
    expect(toastDuration({ kind: 'info', duration: 6000 }, false)).toBe(6000);
  });

  it('mode salle : raccourcie, sauf une erreur', () => {
    expect(toastDuration({ kind: 'success' }, true)).toBe(STAGE_TOAST_MS);
    expect(toastDuration({ kind: 'info', duration: 1200 }, true)).toBe(1200);
    expect(toastDuration({ kind: 'error' }, true)).toBe(TOAST_MS);
  });
});

describe('stageToast', () => {
  it('dernière notification visible, puis vide quand elle part', () => {
    vi.useFakeTimers();
    // Écran « Mode salle » affiché.
    vi.stubGlobal('document', { querySelector: () => ({}) });
    const store = notificationsStore();
    expect(store.stageToast()).toBe('');
    store.push({ kind: 'success', message: 'Séance allégée' });
    store.push({ kind: 'info', message: 'Superset : exercice suivant' });
    expect(store.stageToast()).toBe('Superset : exercice suivant');
    vi.advanceTimersByTime(STAGE_TOAST_MS);
    expect(store.stageToast()).toBe('');
  });

  it('hors mode salle : la durée normale s’applique', () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { querySelector: () => null });
    const store = notificationsStore();
    store.push({ kind: 'success', message: 'Enregistré' });
    vi.advanceTimersByTime(STAGE_TOAST_MS);
    expect(store.stageToast()).toBe('Enregistré');
    vi.advanceTimersByTime(TOAST_MS);
    expect(store.stageToast()).toBe('');
  });
});
