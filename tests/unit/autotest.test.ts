import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  MAX_AUTOTEST_RELOADS,
  parsePlan,
  recoveryState,
  resumeStep,
} from '../../apps/web/src/lib/autotest';

describe('parsePlan', () => {
  it('garde les routes internes valides et borne la durée', () => {
    expect(
      parsePlan(
        JSON.stringify({ demo: true, routes: ['/seances', 'https://x', '/', 3], stepMs: 10 }),
      ),
    ).toEqual({ demo: true, routes: ['/seances', '/'], stepMs: 3500 });
  });

  it('refuse un contenu illisible', () => {
    expect(parsePlan('pas du json')).toBeNull();
    expect(parsePlan('null')).toBeNull();
  });

  it('valeurs par défaut', () => {
    expect(parsePlan('{}')).toEqual({ demo: false, routes: [], stepMs: 3500 });
  });
});

describe('reprise après rechargement (stockage bloqué)', () => {
  it('parsePlan garde l’état du parcours (étape à refaire, rechargements)', () => {
    expect(parsePlan(JSON.stringify({ routes: ['/'], next: 3, reloads: 1 }))).toEqual({
      demo: false,
      routes: ['/'],
      stepMs: 3500,
      next: 3,
      reloads: 1,
    });
    // Valeurs invalides ignorées.
    expect(parsePlan(JSON.stringify({ next: -1, reloads: 1.5 }))).toEqual({
      demo: false,
      routes: [],
      stepMs: 3500,
    });
  });

  it('premier passage : étape 0 ; plan déjà en cours : même étape, rechargement compté', () => {
    expect(resumeStep({ routes: ['/a', '/b'] })).toEqual({ start: 0, reloads: 0 });
    expect(resumeStep({ routes: ['/a', '/b'], next: 1 })).toEqual({ start: 1, reloads: 1 });
    expect(resumeStep({ routes: ['/a', '/b'], next: 1, reloads: 2 })).toEqual({
      start: 1,
      reloads: 3,
    });
    expect(resumeStep({ routes: ['/a'], next: 9 })).toEqual({ start: 1, reloads: 1 });
  });

  it('rechargements répétés : parcours abandonné (aucune boucle)', () => {
    expect(resumeStep({ routes: ['/a'], next: 0, reloads: MAX_AUTOTEST_RELOADS })).toBeNull();
  });

  it('état de la reprise : message de secours affiché, rechargement automatique (âge)', () => {
    const doc = (present: boolean) => ({
      getElementById: (id: string) =>
        present && id === 'k-storage-stuck' ? ({} as HTMLElement) : null,
    });
    const session = (value: string | null) => ({
      getItem: (k: string) => (k === STORAGE_KEYS.STORAGE_UNRESPONSIVE_RELOAD_AT ? value : null),
    });
    expect(recoveryState(doc(false), session(null), 10_000)).toEqual({
      secours: false,
      rechargementAuto: null,
    });
    expect(recoveryState(doc(true), session('4000'), 10_000)).toEqual({
      secours: true,
      rechargementAuto: 6000,
    });
    expect(recoveryState(doc(false), null, 10_000).rechargementAuto).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('bloqué');
      },
    };
    expect(recoveryState(doc(false), throwing, 1).rechargementAuto).toBeNull();
  });
});
