/**
 * Records page — vue agrégée de tous les records personnels (meilleur e1RM par
 * exercice). Source de vérité = sessions enregistrées + détection PR via
 * analytics domain.
 */
import { STORAGE_KEYS, detectPRs, type AnalyticsSet } from '@kinetic/core';
import { getDeps } from '../deps';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { loadExercises, loadSessions } from '../lib/training/storage';

const RECENT_DAYS = 7;

interface DisplayRecord {
  exerciseId: string;
  exerciseName: string;
  weightKg: number;
  weightLabel: string;
  reps: number;
  e1rmKg: number;
  achievedAt: string;
  isRecent: boolean;
  dateLabel: string;
}

function formatDateLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  try {
    return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatWeight(weightKg: number): string {
  if (weightKg === 0) return 'PC';
  return weightKg % 1 === 0 ? `${weightKg} kg` : `${weightKg.toFixed(1)} kg`;
}

export function records() {
  return {
    loading: true,
    records: [] as DisplayRecord[],
    sort: 'recent' as 'e1rm' | 'recent' | 'name',

    get subtitleLabel(): string {
      if (this.loading) return '';
      const n = this.records.length;
      if (n === 0) return 'Pas encore de records';
      return `${n} record${n > 1 ? 's' : ''} personnel${n > 1 ? 's' : ''}`;
    },

    get topE1rm(): number {
      if (this.records.length === 0) return 0;
      return Math.round(Math.max(...this.records.map((r) => r.e1rmKg)));
    },

    get recentCount(): number {
      return this.records.filter((r) => r.isRecent).length;
    },

    get sortedRecords(): DisplayRecord[] {
      const list = [...this.records];
      if (this.sort === 'e1rm') {
        list.sort((a, b) => b.e1rmKg - a.e1rmKg);
      } else if (this.sort === 'recent') {
        list.sort((a, b) => b.achievedAt.localeCompare(a.achievedAt));
      } else {
        list.sort((a, b) => a.exerciseName.localeCompare(b.exerciseName, 'fr'));
      }
      return list;
    },

    async init(): Promise<void> {
      this.loading = true;
      try {
        const deps = await getDeps();
        const [sessions, exercises] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
        ]);
        this.records = this._computeRecords(sessions, exercises);
      } catch (err) {
        console.error('[records] init failed:', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Impossible de charger les records.' },
          }),
        );
      } finally {
        this.loading = false;
      }
    },

    _computeRecords(
      sessions: readonly WorkoutSession[],
      exercises: readonly Exercise[],
    ): DisplayRecord[] {
      const nameById = new Map(exercises.map((e) => [e.id, e.name]));
      const musclesById = new Map(exercises.map((e) => [e.id, e.muscles]));

      const sets: AnalyticsSet[] = [];
      for (const s of sessions) {
        for (const entry of s.entries) {
          const muscles = musclesById.get(entry.exerciseId) ?? [];
          for (const set of entry.sets) {
            sets.push({
              sessionId: s.id,
              exerciseId: entry.exerciseId,
              muscles,
              reps: set.reps,
              weightKg: set.weightKg,
              rpe: set.rpe,
              performedAt: set.performedAt,
            });
          }
        }
      }

      // detectPRs renvoie tous les nouveaux records dans l'ordre chronologique ;
      // on ne garde que le DERNIER par exercice (= record actuel).
      const allPrs = detectPRs(sets);
      const latestByExercise = new Map<string, (typeof allPrs)[number]>();
      for (const pr of allPrs) {
        latestByExercise.set(pr.exerciseId, pr);
      }

      const now = Date.now();
      const recentCutoff = now - RECENT_DAYS * 86_400_000;

      return [...latestByExercise.values()].map((pr): DisplayRecord => {
        const achievedAtMs = Date.parse(pr.achievedAt);
        return {
          exerciseId: pr.exerciseId,
          exerciseName: nameById.get(pr.exerciseId) ?? pr.exerciseId,
          weightKg: pr.weightKg,
          weightLabel: formatWeight(pr.weightKg),
          reps: pr.reps,
          e1rmKg: pr.e1rmKg,
          achievedAt: pr.achievedAt,
          isRecent: Number.isFinite(achievedAtMs) && achievedAtMs >= recentCutoff,
          dateLabel: formatDateLabel(pr.achievedAt, now),
        };
      });
    },
  };
}
