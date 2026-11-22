/**
 * Corps : carte « Masse grasse estimée » (Mensurations, Poids), comparateur
 * avant / après (Photos) et photos de la démo.
 */
import { describe, it, expect, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';

const data = new Map<string, unknown>();
vi.mock('../../apps/web/src/deps.js', () => ({
  getDeps: vi.fn().mockResolvedValue({
    storage: {
      get: vi.fn((k: string) => Promise.resolve(data.get(k) ?? null)),
      set: vi.fn(),
      remove: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      clear: vi.fn(),
    },
  }),
}));
vi.mock('../../apps/web/src/lib/photos', () => ({
  loadPhotos: vi.fn().mockResolvedValue([]),
  deletePhoto: vi.fn(),
  compressImageFile: vi.fn(),
  addPhoto: vi.fn(),
  getPhotoObjectUrl: vi.fn().mockResolvedValue(null),
}));

import { bodyFatCard } from '../../apps/web/src/components/body-fat';
import { photosPage } from '../../apps/web/src/pages/photos.page';
import { buildDemoData, demoPhotoDataUrl } from '../../apps/web/src/lib/demo';

const profile = (sex: 'male' | 'female', heightCm = 180) => ({
  version: 1,
  createdAt: '',
  updatedAt: '',
  sex,
  ageYears: 30,
  heightCm,
  weightKg: 80,
  activity: 'moderate',
  goal: 'recomp',
});

describe('bodyFatCard', () => {
  it('estime le %, les masses, la courbe, et garde le % saisi à la main', async () => {
    data.clear();
    data.set(STORAGE_KEYS.USER_PROFILE, profile('male'));
    data.set(STORAGE_KEYS.MEASUREMENTS_ENTRIES, [
      { id: 'a', date: '2026-09-01', waist: 84, neck: 38 },
      { id: 'b', date: '2026-11-20', waist: 81.6, neck: 38.4 },
    ]);
    data.set(STORAGE_KEYS.BODYWEIGHT_ENTRIES, [
      { date: '2026-09-01', weight: 80, bodyFatPct: null, note: null },
      { date: '2026-11-18', weight: 77.6, bodyFatPct: 16, note: null },
    ]);
    const c = bodyFatCard();
    await c.init();
    expect(c.hasEstimate).toBe(true);
    expect(c.pctText).toBe('13,1');
    expect(c.categoryLabel).toBe('Athlétique');
    expect(c.deltaText).toMatch(/^−2,2 points depuis le/);
    expect(c.leanText).toBe('67,4');
    expect(c.fatText).toBe('10,2');
    expect(c.manualText).toMatch(/^16,0 % saisi le/);
    expect(c.chartScrub()?.points).toHaveLength(2);
    expect(c.chartSvg()).toContain('<svg');
  });

  it('femme sans hanches : liste ce qui manque', async () => {
    data.clear();
    data.set(STORAGE_KEYS.USER_PROFILE, profile('female', 165));
    data.set(STORAGE_KEYS.MEASUREMENTS_ENTRIES, [
      { id: 'a', date: '2026-11-01', waist: 70, neck: 32 },
    ]);
    const c = bodyFatCard();
    await c.init();
    expect(c.hasEstimate).toBe(false);
    expect(c.missingText).toBe("Pour l'estimer, il manque le tour de hanches.");
    expect(c.needsProfile).toBe(false);
  });

  it('sans profil : invite à le renseigner', async () => {
    data.clear();
    const c = bodyFatCard();
    await c.init();
    expect(c.needsProfile).toBe(true);
    expect(c.missingText).toContain('ta taille (profil)');
  });
});

describe('photosPage : comparateur', () => {
  it('paire par défaut, écart, curseur au clavier, inversion', () => {
    const page = photosPage();
    page.photos = [
      { id: 'a', takenAt: '2026-08-01T08:00:00Z', label: 'front' },
      { id: 'b', takenAt: '2026-08-01T08:05:00Z', label: 'side' },
      { id: 'c', takenAt: '2026-10-24T08:00:00Z', label: 'front' },
    ];
    page.weights = [
      { date: '2026-08-01', weight: 80.4 },
      { date: '2026-10-24', weight: 77.2 },
    ];
    page._resetPair();
    expect([page.compareBeforeId, page.compareAfterId]).toEqual(['a', 'c']);
    expect(page.gapLabel).toBe('12 semaines · −3,2 kg');
    page.swapPair();
    expect(page.compareBeforeId).toBe('c');
    expect(page.gapLabel).toBe('12 semaines · −3,2 kg');

    const key = (k: string) => ({ key: k, preventDefault: vi.fn() }) as unknown as KeyboardEvent;
    page.splitKey(key('ArrowLeft'));
    expect(page.split).toBe(45);
    page.splitKey(key('End'));
    expect(page.split).toBe(100);
    expect(page.beforeClipStyle).toBe('clip-path: inset(0 0% 0 0)');
    expect(page.handleStyle).toBe('left: 100%');
    page.setSide();
    expect(page.isOverlay).toBe(false);
  });

  it('glisser met à jour le curseur', () => {
    const page = photosPage();
    const el = {
      getBoundingClientRect: () => ({ left: 10, width: 200 }),
      setPointerCapture: vi.fn(),
    };
    const ev = (x: number) =>
      ({ clientX: x, button: 0, pointerId: 1, currentTarget: el }) as unknown as PointerEvent;
    page.splitDown(ev(60));
    expect(page.split).toBe(25);
    page.splitMove(ev(160));
    expect(page.split).toBe(75);
    page.splitUp();
    page.splitMove(ev(10));
    expect(page.split).toBe(75);
  });
});

describe('démo : photos de progrès', () => {
  it('silhouettes SVG en data URL, deux poses', () => {
    expect(demoPhotoDataUrl(50, 'front')).toMatch(/^data:image\/svg\+xml;base64,/);
    const { values } = buildDemoData(new Date(2026, 10, 22));
    const photos = values.find(([k]) => k === STORAGE_KEYS.PROGRESS_PHOTOS)?.[1] as Array<{
      label: string;
    }>;
    expect(photos).toHaveLength(4);
    expect(photos.filter((p) => p.label === 'front')).toHaveLength(3);
    const measures = values.find(([k]) => k === STORAGE_KEYS.MEASUREMENTS_ENTRIES)?.[1] as Array<{
      neck?: number;
    }>;
    expect(measures.every((m) => typeof m.neck === 'number')).toBe(true);
  });
});
