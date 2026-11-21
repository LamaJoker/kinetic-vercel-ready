import { describe, it, expect } from 'vitest';
import { STORAGE_KEYS, PRESET_SPLITS } from '@kinetic/core';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  loadProgramWeek,
  mondayOf,
  programWeekKey,
  resolveFollowedProgram,
  saveProgramWeekAdjust,
  templateForToday,
} from '../../apps/web/src/lib/program-week.js';
import { saveSession } from '../../apps/web/src/lib/training/storage.js';
import { DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';
import { loadDemoData } from '../../apps/web/src/lib/demo.js';
import { isBackedUpKey } from '../../apps/web/src/lib/backup.js';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types.js';

const WED = new Date(2026, 10, 18, 12, 0); // mercredi 18 novembre 2026

const ul = {
  id: 'prog-ul',
  name: 'Haut / Bas',
  createdAt: '2026-11-01T10:00:00.000Z',
  schedule: PRESET_SPLITS.upper_lower.schedule,
};

function workout(name: string, date: Date): WorkoutSession {
  const at = date.toISOString();
  return {
    id: `w-${at}`,
    name,
    startedAt: at,
    endedAt: at,
    entries: [
      { exerciseId: 'bp', sets: [{ setIndex: 0, reps: 5, weightKg: 60, performedAt: at }] },
    ],
  } as WorkoutSession;
}

describe('programme suivi', () => {
  it('aucun programme : null', async () => {
    expect(await loadProgramWeek(new InMemoryStorage(), WED)).toBeNull();
    expect(resolveFollowedProgram(null, { id: 'inconnu' })).toBeNull();
  });

  it('le plus récemment choisi gagne (catalogue vs découpage)', () => {
    const older = resolveFollowedProgram(ul, { id: '531-bbb', weekIndex: 1 });
    expect(older?.href).toBe('/program');
    const newer = resolveFollowedProgram(ul, {
      id: '531-bbb',
      weekIndex: 1,
      selectedAt: '2026-11-10T10:00:00.000Z',
    });
    expect(newer).toMatchObject({ href: '/programs', programId: '531-bbb#1', title: '5/3/1 BBB' });
    expect(newer?.subtitle).toMatch(/Semaine 2/);
    expect(resolveFollowedProgram(null, { id: '531-bbb', weekIndex: 99 })?.programId).toBe(
      '531-bbb#3',
    );
  });

  it('clé de semaine identique à celle de /program', () => {
    expect(programWeekKey(mondayOf(WED))).toBe('2026-W11-16');
  });
});

describe('loadProgramWeek', () => {
  it('séance de lundi faite, celle de mardi ratée : déplacée à mercredi', async () => {
    const storage = new InMemoryStorage();
    await storage.set(STORAGE_KEYS.PROGRAM_ACTIVE, ul);
    await saveSession(storage, workout('Upper A', new Date(2026, 10, 16, 18)));
    await saveSession(storage, workout('Ancienne', new Date(2026, 10, 10, 18))); // semaine passée
    const view = (await loadProgramWeek(storage, WED))!;
    expect(view.today).toBe(2);
    expect(view.done).toEqual([{ day: 0, name: 'Upper A' }]);
    expect(view.plan.items[0]!.status).toBe('done');
    expect(view.plan.today?.name).toBe('Bas du corps A');
    expect(view.plan.messages).toContain('Bas du corps A déplacé à mercredi');
  });

  it('compte les jours cochés dans /program', async () => {
    const storage = new InMemoryStorage();
    await storage.set(STORAGE_KEYS.PROGRAM_ACTIVE, ul);
    await storage.set(STORAGE_KEYS.PROGRAM_COMPLETED_DAYS('2026-W11-16'), [1, 2]);
    const view = (await loadProgramWeek(storage, WED))!;
    expect(view.plan.doneCount).toBe(2);
    expect(view.plan.messages).toEqual([]);
  });

  it('ajustements : enregistrés pour la semaine et le programme, ignorés sinon', async () => {
    const storage = new InMemoryStorage();
    await storage.set(STORAGE_KEYS.PROGRAM_ACTIVE, ul);
    const view = (await loadProgramWeek(storage, WED))!;
    const next = await saveProgramWeekAdjust(storage, view, { unavailable: [3] });
    expect(next.plan.days[3]!.unavailable).toBe(true);
    expect(await storage.get(STORAGE_KEYS.PROGRAM_WEEK_PLAN)).toMatchObject({
      week: '2026-11-16',
      programId: 'prog-ul',
      unavailable: [3],
    });
    expect((await loadProgramWeek(storage, WED))!.adjust.unavailable).toEqual([3]);
    // Semaine suivante : on repart de zéro.
    const nextWeek = (await loadProgramWeek(storage, new Date(2026, 10, 25, 12)))!;
    expect(nextWeek.adjust).toEqual({});
  });

  it('« Séance du jour » : modèle du même nom (Jambes ≈ Legs)', async () => {
    const storage = new InMemoryStorage();
    await storage.set(STORAGE_KEYS.PROGRAM_ACTIVE, {
      id: 'ppl',
      createdAt: '2026-11-01T00:00:00.000Z',
      schedule: PRESET_SPLITS.ppl.schedule,
    });
    const view = (await loadProgramWeek(storage, WED))!;
    expect(view.plan.today?.name).toBe('Push A'); // lundi et mardi ratés
    expect(templateForToday(view, DEFAULT_TEMPLATES)?.id).toBe('tpl-push-a');
    const legs = {
      ...view,
      plan: { ...view.plan, today: { ...view.plan.today!, name: 'Jambes A' } },
    };
    expect(templateForToday(legs, DEFAULT_TEMPLATES)?.id).toBe('tpl-legs-a');
  });

  it('les ajustements sont sauvegardés (export/sauvegarde)', () => {
    expect(isBackedUpKey(STORAGE_KEYS.PROGRAM_WEEK_PLAN)).toBe(true);
  });
});

describe('démo', () => {
  it('montre un programme suivi avec une séance déplacée', async () => {
    const storage = new InMemoryStorage();
    await loadDemoData(storage, WED);
    const view = (await loadProgramWeek(storage, WED))!;
    expect(view.title).toBe('Push Pull Legs — 4 jours');
    expect(view.plan.total).toBe(4);
    expect(view.plan.doneCount).toBeGreaterThanOrEqual(1);
    expect(view.plan.days[3]!.unavailable).toBe(true); // jeudi, prochain jour prévu
    expect(view.plan.messages.some((m) => m.includes('déplacé à vendredi'))).toBe(true);
  });

  it('chaque jour de la semaine : aujourd’hui n’est jamais marqué indisponible', async () => {
    for (let i = 0; i < 7; i++) {
      const now = new Date(2026, 10, 16 + i, 15); // lundi 16 → dimanche 22 nov. 2026
      const storage = new InMemoryStorage();
      await loadDemoData(storage, now);
      const view = (await loadProgramWeek(storage, now))!;
      expect(view.plan.days[view.today]!.unavailable).toBe(false);
    }
  });
});
