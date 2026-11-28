/**
 * Pesées et mensurations à une date choisie (pages bodyweight / mensurations) :
 * saisie passée insérée à sa place, confirmation avant de remplacer le même jour,
 * modification (y compris de la date), suppression annulable, poids actuel inchangé.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const stored = new Map<string, unknown>();
const storage = {
  get: vi.fn(async (k: string) => stored.get(k) ?? null),
  set: vi.fn(async (k: string, v: unknown) => void stored.set(k, v)),
  remove: vi.fn(),
  keys: vi.fn(async () => [...stored.keys()]),
  clear: vi.fn(),
};

vi.mock('../../apps/web/src/deps.js', () => ({ getDeps: vi.fn(async () => ({ storage })) }));
vi.mock('../../apps/web/src/lib/health.js', () => ({ writeBodyweight: vi.fn() }));
vi.mock('../../apps/web/src/lib/haptics.js', () => ({
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));
vi.mock('@capacitor/camera', () => ({ Camera: {}, CameraResultType: {}, CameraSource: {} }));

import { STORAGE_KEYS } from '@kinetic/core';
import { bodyweight } from '../../apps/web/src/pages/bodyweight.page.js';
import { mensurations } from '../../apps/web/src/pages/mensurations.page.js';
import { localIsoDate } from '../../apps/web/src/lib/widget.js';
import { writeBodyweight } from '../../apps/web/src/lib/health.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localIsoDate(d);
}

const events: Event[] = [];

beforeEach(() => {
  stored.clear();
  events.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => void events.push(e) });
  vi.stubGlobal('document', { getElementById: () => null });
});
afterEach(() => vi.unstubAllGlobals());

const bw = (date: string, weight: number) => ({ date, weight, bodyFatPct: null, note: null });

describe('pesée à une date choisie', () => {
  it('date par défaut = aujourd’hui (local), date future refusée', () => {
    const s = bodyweight();
    expect(s.newDate).toBe(localIsoDate());
    s.newWeight = 80;
    expect(s.canSave).toBe(true);
    s.newDate = '2999-01-01';
    expect(s.dateError).toMatch(/futur/);
    expect(s.canSave).toBe(false);
    s.newDate = '1999-12-31';
    expect(s.canSave).toBe(false);
  });

  it('une pesée passée s’insère à sa place sans toucher au poids actuel', async () => {
    const s = bodyweight();
    s.entries = [bw(daysAgo(30), 84), bw(daysAgo(1), 80)];
    s.newDate = daysAgo(10);
    s.newWeight = 82;
    await s.addEntry();
    expect(s.entries.map((e) => e.weight)).toEqual([84, 82, 80]);
    expect(s.latest?.weight).toBe(80);
    expect(stored.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toEqual(s.entries);
    expect(writeBodyweight).toHaveBeenCalledWith(82, null, daysAgo(10));
    // Formulaire remis à zéro, date revenue à aujourd'hui.
    expect(s.newWeight).toBeNull();
    expect(s.newDate).toBe(localIsoDate());
  });

  it('demande confirmation avant de remplacer la pesée du même jour', async () => {
    const s = bodyweight();
    s.entries = [bw(daysAgo(5), 81), bw(daysAgo(1), 80)];
    s.newDate = daysAgo(5);
    s.newWeight = 81.6;
    await s.addEntry();
    expect(s.askReplace).toBe(true);
    expect(s.replaceMessage).toMatch(/existe déjà/);
    expect(storage.set).not.toHaveBeenCalled();
    s.cancelReplace();
    expect(s.askReplace).toBe(false);
    await s.addEntry(); // redemande
    await s.addEntry(); // confirmé
    expect(s.entries.map((e) => e.weight)).toEqual([81.6, 80]);
    expect(s.undoEntries).not.toBeNull();
  });

  it('modifie une pesée et sa date depuis l’historique', async () => {
    const s = bodyweight();
    s.entries = [bw(daysAgo(20), 85), bw(daysAgo(10), 83), bw(daysAgo(1), 80)];
    s.startEdit(s.entries[1]!);
    expect(s.formTitle).toBe('Modifier la pesée');
    expect(s.newWeight).toBe(83);
    s.newDate = daysAgo(12);
    s.newWeight = 83.4;
    expect(s.replaceTarget).toBeNull();
    await s.addEntry();
    expect(s.entries.map((e) => [e.date, e.weight])).toEqual([
      [daysAgo(20), 85],
      [daysAgo(12), 83.4],
      [daysAgo(1), 80],
    ]);
    expect(s.editingDate).toBeNull();
  });

  it('supprime une pesée avec annulation possible', async () => {
    const s = bodyweight();
    const before = [bw(daysAgo(3), 81), bw(daysAgo(1), 80)];
    s.entries = before;
    await s.removeEntry(daysAgo(1));
    expect(s.entries).toHaveLength(1);
    expect(s.undoLabel).toMatch(/supprimée/);
    await s.undoLast();
    expect(s.entries).toEqual(before);
    expect(stored.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toEqual(before);
  });

  it('poids actuel = pesée la plus récente même si le tableau est désordonné', () => {
    const s = bodyweight();
    s.entries = [bw(daysAgo(1), 80), bw(daysAgo(40), 90)];
    expect(s.latest?.weight).toBe(80);
  });
});

describe('mensurations à une date choisie', () => {
  it('enregistre à la date choisie (locale) sans toucher aux autres dates', async () => {
    const s = mensurations();
    s.entries = [{ id: 'a', date: daysAgo(1), waist: 80 }];
    expect(s.fDate).toBe(localIsoDate());
    s.fDate = daysAgo(20);
    s.fWaist = 83;
    await s.addEntry();
    expect(s.entries.map((e) => [e.date, e.waist])).toEqual([
      [daysAgo(20), 83],
      [daysAgo(1), 80],
    ]);
    expect(s.currentValue('waist')).toBe(80);
  });

  it('refuse une date future', async () => {
    const s = mensurations();
    s.fDate = '2999-01-01';
    s.fWaist = 80;
    expect(s.canSave).toBe(false);
    await s.addEntry();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('fusion avec les mesures du même jour seulement après confirmation', async () => {
    const s = mensurations();
    s.entries = [
      { id: 'a', date: daysAgo(10), waist: 82, neck: 38 },
      { id: 'b', date: daysAgo(1), waist: 80 },
    ];
    s.fDate = daysAgo(10);
    s.fWaist = 81;
    await s.addEntry();
    expect(s.askMerge).toBe(true);
    expect(storage.set).not.toHaveBeenCalled();
    await s.addEntry();
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]).toMatchObject({ id: 'a', waist: 81, neck: 38 });
    expect(s.entries[1]).toEqual({ id: 'b', date: daysAgo(1), waist: 80 });
  });

  it('modifie une entrée (valeurs et date) et supprime avec annulation', async () => {
    const s = mensurations();
    s.entries = [
      { id: 'a', date: daysAgo(10), waist: 82, chest: 100 },
      { id: 'b', date: daysAgo(1), waist: 80 },
    ];
    s.startEdit(s.entries[0]!);
    expect(s.fChest).toBe(100);
    s.fChest = null; // mesure retirée
    s.fDate = daysAgo(15);
    await s.addEntry();
    expect(s.entries[0]).toMatchObject({ id: 'a', date: daysAgo(15), waist: 82 });
    expect(s.entries[0]!.chest).toBeUndefined();
    expect(s.entrySummary(s.entries[0]!)).toBe('Taille 82');

    const before = s.entries;
    await s.removeEntry('b');
    expect(s.entries).toHaveLength(1);
    await s.undoLast();
    expect(s.entries).toEqual(before);
  });
});

describe('« Annuler » ne fait jamais perdre une saisie faite après', () => {
  it('pesées : un remplacement puis une nouvelle pesée — le bandeau d’annulation disparaît', async () => {
    const s = bodyweight();
    s.entries = [bw(daysAgo(5), 80), bw(daysAgo(1), 79)];
    s.newDate = daysAgo(5);
    s.newWeight = 81;
    await s.addEntry();
    await s.addEntry(); // confirmation « Remplacer »
    expect(s.undoEntries).not.toBeNull();
    // Nouvelle pesée d'aujourd'hui pendant que le bandeau est affiché.
    s.newWeight = 78;
    await s.addEntry();
    await s.undoLast();
    expect(s.entries.map((e) => e.weight)).toEqual([81, 79, 78]);
    expect(stored.get(STORAGE_KEYS.BODYWEIGHT_ENTRIES)).toEqual(s.entries);
  });

  it('mensurations : une suppression puis une nouvelle mesure — l’annulation ne l’efface pas', async () => {
    const s = mensurations();
    s.entries = [
      { id: 'a', date: daysAgo(10), waist: 82 },
      { id: 'b', date: daysAgo(1), waist: 80 },
    ];
    await s.removeEntry('a');
    s.fWaist = 79;
    await s.addEntry();
    await s.undoLast();
    expect(s.entries.map((e) => e.waist)).toEqual([80, 79]);
  });
});
