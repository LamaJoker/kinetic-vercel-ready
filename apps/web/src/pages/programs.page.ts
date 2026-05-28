import {
  PROGRAMS_CATALOG,
  findProgram,
  resolveProgramSession,
  STORAGE_KEYS,
  type LiftKey,
  type OneRepMaxes,
  type ProgramCatalogEntry,
  type ResolvedSession,
} from '@kinetic/core';
import { getDeps } from '../deps';

const LIFT_LABELS: Record<LiftKey, string> = {
  squat: 'Squat',
  bench: 'Bench Press',
  deadlift: 'Deadlift',
  overhead_press: 'Overhead Press',
  row: 'Barbell Row',
};

export function programsPage() {
  return {
    catalog: PROGRAMS_CATALOG,
    selectedProgram: null as ProgramCatalogEntry | null,
    oneRms: {} as OneRepMaxes,
    currentWeekIndex: 0,

    async init(): Promise<void> {
      try {
        const deps = await getDeps();
        const saved = await deps.storage.get<OneRepMaxes>(STORAGE_KEYS.PROGRAM_ONE_RMS);
        if (saved && typeof saved === 'object') this.oneRms = saved;
        const active = await deps.storage.get<{ id: string; weekIndex: number }>(
          STORAGE_KEYS.ACTIVE_PROGRAM,
        );
        if (active?.id) {
          const program = findProgram(active.id);
          if (program) {
            this.selectedProgram = program;
            this.currentWeekIndex = Math.min(
              Math.max(0, active.weekIndex || 0),
              program.weeks.length - 1,
            );
          }
        }
      } catch (err) {
        console.error('[programs] init failed:', err);
      }
    },

    select(id: string): void {
      const program = findProgram(id);
      if (!program) return;
      this.selectedProgram = program;
      this.currentWeekIndex = 0;
      this._persistActive();
    },

    back(): void {
      this.selectedProgram = null;
    },

    prevWeek(): void {
      if (this.currentWeekIndex > 0) {
        this.currentWeekIndex -= 1;
        this._persistActive();
      }
    },

    nextWeek(): void {
      if (this.selectedProgram && this.currentWeekIndex < this.selectedProgram.weeks.length - 1) {
        this.currentWeekIndex += 1;
        this._persistActive();
      }
    },

    async setOneRm(lift: LiftKey, value: string): Promise<void> {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return;
      this.oneRms = { ...this.oneRms, [lift]: num };
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEYS.PROGRAM_ONE_RMS, this.oneRms);
      } catch (err) {
        console.warn('[programs] persist 1RM failed:', err);
      }
    },

    liftLabel(key: LiftKey): string {
      return LIFT_LABELS[key] ?? key;
    },

    get requiredLifts(): LiftKey[] {
      if (!this.selectedProgram) return [];
      const lifts = new Set<LiftKey>();
      for (const week of this.selectedProgram.weeks) {
        for (const session of week.sessions) {
          for (const ex of session.exercises) lifts.add(ex.liftRef);
        }
      }
      return [...lifts];
    },

    get resolvedSessions(): ResolvedSession[] {
      if (!this.selectedProgram) return [];
      const week = this.selectedProgram.weeks[this.currentWeekIndex];
      if (!week) return [];
      return week.sessions.map((s) =>
        resolveProgramSession(s, this.oneRms, this.selectedProgram!.trainingMaxFactor, 2.5),
      );
    },

    async _persistActive(): Promise<void> {
      if (!this.selectedProgram) return;
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEYS.ACTIVE_PROGRAM, {
          id: this.selectedProgram.id,
          weekIndex: this.currentWeekIndex,
        });
      } catch (err) {
        console.warn('[programs] persist active failed:', err);
      }
    },
  };
}
