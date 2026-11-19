import { describe, it, expect } from 'vitest';
import {
  buildShareCardSummary,
  shareCardFileName,
  shareDurationParts,
  shareTonnageParts,
  sessionDurationMin,
  shareDateLabel,
  SHARE_CARD_SIZES,
  type ShareSessionInput,
} from '@kinetic/core';

const names: Record<string, string> = {
  bp: 'Développé couché',
  sq: 'Squat',
  curl: 'Curl',
  plank: 'Gainage',
  row: 'Rowing barre',
  dl: 'Soulevé de terre',
  ohp: 'Développé militaire',
};
const nameOf = (id: string) => names[id] ?? id;

const set = (weightKg: number, reps: number, extra: Record<string, unknown> = {}) => ({
  weightKg,
  reps,
  ...extra,
});

function session(
  id: string,
  startedAt: string,
  entries: ShareSessionInput['entries'],
  extra: Partial<ShareSessionInput> = {},
): ShareSessionInput {
  return { id, name: 'Push', startedAt, entries, ...extra };
}

describe('carte « Partager en image » : résumé de séance', () => {
  const past = session('s1', '2026-11-10T10:00:00', [
    { exerciseId: 'bp', sets: [set(80, 5), set(80, 5)] },
    { exerciseId: 'sq', sets: [set(100, 5)] },
  ]);

  it('tonnage, séries et exercices sans les échauffements', () => {
    const s = session(
      's2',
      '2026-11-17T18:00:00',
      [
        { exerciseId: 'bp', sets: [set(40, 10, { kind: 'warmup' }), set(80, 5), set(80, 5)] },
        { exerciseId: 'curl', sets: [set(15, 10, { kind: 'warmup' })] },
      ],
      { durationMin: 52 },
    );
    const sum = buildShareCardSummary(s, [past, s], nameOf);
    expect(sum.setCount).toBe(2);
    expect(sum.exerciseCount).toBe(1);
    expect(sum.tonnage).toEqual({ value: '800', unit: 'kg' });
    expect(sum.duration).toEqual({ value: '52', unit: 'min' });
    expect(sum.top.map((t) => t.name)).toEqual(['Développé couché']);
  });

  it('record battu seulement au-dessus d’une référence antérieure', () => {
    const s = session('s2', '2026-11-17T18:00:00', [
      { exerciseId: 'bp', sets: [set(85, 5)] }, // e1RM > 80×5 : record
      { exerciseId: 'sq', sets: [set(90, 5)] }, // en dessous : pas de record
      { exerciseId: 'row', sets: [set(70, 8)] }, // première fois : pas un record « battu »
    ]);
    const later = session('s3', '2026-11-20T18:00:00', [{ exerciseId: 'bp', sets: [set(120, 5)] }]);
    const sum = buildShareCardSummary(s, [past, s, later], nameOf);
    expect(sum.records).toEqual([
      { exerciseId: 'bp', name: 'Développé couché', label: '85 kg × 5' },
    ]);
  });

  it('les échauffements et séries chronométrées ne font pas de record', () => {
    const s = session('s2', '2026-11-17T18:00:00', [
      { exerciseId: 'bp', sets: [set(200, 5, { kind: 'warmup' }), set(70, 5)] },
      { exerciseId: 'plank', sets: [set(0, 0, { durationSec: 90 })] },
    ]);
    expect(buildShareCardSummary(s, [past, s], nameOf).records).toEqual([]);
  });

  it('exercices phares triés par tonnage, limités selon le format', () => {
    const ids = ['bp', 'sq', 'curl', 'row', 'dl', 'ohp', 'plank'];
    const s = session(
      's2',
      '2026-11-17T18:00:00',
      ids.map((id, i) => ({
        exerciseId: id,
        sets:
          id === 'plank'
            ? [set(0, 0, { durationSec: 45 }), set(0, 0, { durationSec: 45 })]
            : [set(10 * (i + 1), 10)],
      })),
    );
    const post = buildShareCardSummary(s, [s], nameOf, 'post');
    const story = buildShareCardSummary(s, [s], nameOf, 'story');
    expect(post.top).toHaveLength(4);
    expect(story.top).toHaveLength(6);
    expect(post.top[0]!.exerciseId).toBe('ohp');
    expect(post.top[0]!.share).toBe(1);
    expect(post.top[1]!.share).toBeCloseTo(50 / 60);
    const all = buildShareCardSummary(s, [s], nameOf, 'story');
    expect(all.exerciseCount).toBe(7);
    // Gainage : détail en durée, pas de tonnage.
    const plank = buildShareCardSummary(
      session('p', '2026-11-17T18:00:00', [s.entries[6]!]),
      [],
      nameOf,
    );
    expect(plank.top[0]!.detail).toBe('2 séries · 1:30');
    // Distance : la distance d'abord, avec le temps pour une seule série.
    const walk = (sets: Array<{ durationSec?: number; distanceM: number }>) =>
      buildShareCardSummary(
        session('w', '2026-11-17T18:00:00', [
          {
            exerciseId: 'farmerswalk',
            sets: sets.map((x, i) => ({
              setIndex: i,
              reps: 0,
              weightKg: 32,
              performedAt: '2026-11-17T18:05:00',
              ...x,
            })),
          },
        ]),
        [],
        nameOf,
      ).top[0]!.detail;
    expect(walk([{ distanceM: 40, durationSec: 35 }])).toBe('1 série · 40 m en 0:35');
    expect(walk([{ distanceM: 800 }, { distanceM: 1700 }])).toBe('2 séries · 2,5 km');
  });

  it('détails : tonnage par exercice, répétitions au poids du corps', () => {
    const s = session('s2', '2026-11-17T18:00:00', [
      { exerciseId: 'sq', sets: [set(100, 5), set(100, 5), set(100, 5)] },
      { exerciseId: 'pullup', sets: [set(0, 8), set(0, 6)] },
    ]);
    const sum = buildShareCardSummary(s, [], nameOf);
    expect(sum.top[0]!.detail).toBe('3 séries · 1,5 t');
    expect(sum.top[1]!.detail).toBe('2 séries · 14 rép.');
    expect(sum.tonnage).toEqual({ value: '1,5', unit: 't' });
  });

  it('titre par défaut et date en toutes lettres', () => {
    const s = session('s2', '2026-11-17T18:00:00', [], { name: '  ' });
    const sum = buildShareCardSummary(s, [], nameOf);
    expect(sum.title).toBe('Séance');
    expect(sum.dateLabel).toBe('Mardi 17 novembre 2026');
    expect(shareDateLabel('pas une date')).toBe('');
  });
});

describe('carte « Partager en image » : formats et libellés', () => {
  it('durée : minutes, puis heures', () => {
    expect(shareDurationParts(0)).toEqual({ value: '<\u00a01', unit: 'min' });
    expect(shareDurationParts(0, false)).toEqual({ value: '—', unit: '' });
    expect(shareDurationParts(59)).toEqual({ value: '59', unit: 'min' });
    expect(shareDurationParts(65)).toEqual({ value: '1 h 05', unit: '' });
  });

  it('durée enregistrée, sinon début → fin', () => {
    const base = { id: 'x', name: 'x', entries: [] };
    expect(
      sessionDurationMin({ ...base, startedAt: '2026-11-17T18:00:00Z', durationMin: 47 }),
    ).toBe(47);
    expect(
      sessionDurationMin({
        ...base,
        startedAt: '2026-11-17T18:00:00Z',
        endedAt: '2026-11-17T19:12:00Z',
      }),
    ).toBe(72);
    expect(sessionDurationMin({ ...base, startedAt: '2026-11-17T18:00:00Z' })).toBe(0);
  });

  it('tonnage : kg puis tonnes avec virgule', () => {
    expect(shareTonnageParts(840)).toEqual({ value: '840', unit: 'kg' });
    expect(shareTonnageParts(12_400)).toEqual({ value: '12,4', unit: 't' });
    expect(shareTonnageParts(Number.NaN)).toEqual({ value: '0', unit: 'kg' });
  });

  it('formats d’image et nom de fichier', () => {
    expect(SHARE_CARD_SIZES.post).toEqual({ width: 1080, height: 1350 });
    expect(SHARE_CARD_SIZES.story).toEqual({ width: 1080, height: 1920 });
    expect(
      shareCardFileName({ id: 'x', name: 'x', startedAt: '2026-11-07T08:00:00', entries: [] }),
    ).toBe('kinetic-seance-2026-11-07.png');
    expect(shareCardFileName({ id: 'x', name: 'x', startedAt: '?', entries: [] })).toBe(
      'kinetic-seance.png',
    );
  });
});
