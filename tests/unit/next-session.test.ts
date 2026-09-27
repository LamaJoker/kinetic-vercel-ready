import { describe, it, expect } from 'vitest';
import {
  buildTrainingSnapshot,
  pickNextTemplate,
  summarizeSession,
  relativeDayLabel,
  formatVolume,
  localIsoDate,
} from '../../apps/web/src/lib/training/next-session.js';
import { DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

function session(id: string, startedAt: string, templateId?: string, ended = true): WorkoutSession {
  return {
    id,
    name: id,
    templateId,
    startedAt,
    endedAt: ended ? new Date(Date.parse(startedAt) + 3_600_000).toISOString() : undefined,
    entries: [
      {
        exerciseId: 'bp',
        sets: [
          { setIndex: 0, reps: 8, weightKg: 80, rpe: 8, performedAt: startedAt },
          { setIndex: 1, reps: 6, weightKg: 85, rpe: 9, performedAt: startedAt },
        ],
      },
    ],
  };
}

describe('pickNextTemplate', () => {
  it('propose Push A pour un premier entraînement', () => {
    expect(pickNextTemplate(undefined, DEFAULT_TEMPLATES)?.templateId).toBe('tpl-push-a');
  });

  it('suit la rotation PPL et reboucle après Legs B', () => {
    expect(pickNextTemplate('tpl-push-a', DEFAULT_TEMPLATES)?.templateId).toBe('tpl-pull-a');
    expect(pickNextTemplate('tpl-legs-b', DEFAULT_TEMPLATES)?.templateId).toBe('tpl-push-a');
  });

  it('passe au modèle suivant hors rotation', () => {
    const next = pickNextTemplate('tpl-upper-a', DEFAULT_TEMPLATES);
    expect(next?.reason).toBe('next-template');
    expect(next?.templateId).not.toBe('tpl-upper-a');
  });

  it('renvoie null sans modèle', () => {
    expect(pickNextTemplate(undefined, [])).toBeNull();
  });
});

describe('buildTrainingSnapshot', () => {
  const now = new Date(2026, 8, 24, 18, 0); // jeudi 24 septembre 2026

  it('construit la semaine du lundi au dimanche', () => {
    const snap = buildTrainingSnapshot(
      [
        session('a', new Date(2026, 8, 21, 9).toISOString(), 'tpl-push-a'),
        session('b', new Date(2026, 8, 23, 19).toISOString(), 'tpl-pull-a'),
      ],
      DEFAULT_TEMPLATES,
      now,
    );
    expect(snap.week.days.map((d) => d.label).join('')).toBe('LMMJVSD');
    expect(snap.week.days.map((d) => d.trained)).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(snap.week.days[3]!.isToday).toBe(true);
    expect(snap.week.days[4]!.isFuture).toBe(true);
    expect(snap.week.count).toBe(2);
    expect(snap.next?.templateId).toBe('tpl-legs-a');
    expect(snap.daysSinceLast).toBe(1);
  });

  it('ignore les séances non terminées ou vides', () => {
    const snap = buildTrainingSnapshot(
      [session('open', new Date(2026, 8, 24, 8).toISOString(), 'tpl-push-a', false)],
      DEFAULT_TEMPLATES,
      now,
    );
    expect(snap.last).toBeNull();
    expect(snap.totalSessions).toBe(0);
    expect(snap.next?.reason).toBe('first');
  });
});

describe('helpers', () => {
  it('summarizeSession calcule volume, séries et durée', () => {
    const s = summarizeSession(session('x', '2026-09-24T10:00:00.000Z'));
    expect(s).toMatchObject({ setCount: 2, volumeKg: 8 * 80 + 6 * 85, durationMin: 60 });
  });

  it('relativeDayLabel', () => {
    expect(relativeDayLabel(0)).toBe("aujourd'hui");
    expect(relativeDayLabel(1)).toBe('hier');
    expect(relativeDayLabel(4)).toBe('il y a 4 jours');
    expect(relativeDayLabel(null)).toBe('');
  });

  it('formatVolume', () => {
    expect(formatVolume(840)).toBe('840 kg');
    expect(formatVolume(12_480)).toMatch(/^12,5\s?t$/);
  });

  it('localIsoDate ne décale pas en UTC', () => {
    expect(localIsoDate(new Date(2026, 0, 1, 23, 30))).toBe('2026-01-01');
  });
});
