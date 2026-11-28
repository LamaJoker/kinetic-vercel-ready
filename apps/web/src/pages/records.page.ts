/**
 * Records page — vue agrégée de tous les records personnels (meilleur e1RM par
 * exercice). Source de vérité = sessions enregistrées + détection PR via
 * analytics domain.
 */
import { loc } from '../lib/num';
import {
  STORAGE_KEYS,
  detectPRs,
  wilks2020,
  ipfGoodlift,
  dotsScore,
  tierFromIpfGl,
  type AnalyticsSet,
  type StrengthSex,
  type StrengthTier,
  loadSetsOf,
  timedRecords,
  exerciseMeasure,
  formatDuration,
  formatDistance,
  currentBodyweightKg,
} from '@kinetic/core';
import { getDeps } from '../deps';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { loadExercises, loadSessions } from '../lib/training/storage';
import { notify } from '../lib/notify';

const RECENT_DAYS = 7;

/** Record d'un exercice chronométré : meilleure durée, ou plus longue distance. */
interface TimedDisplayRecord {
  exerciseId: string;
  exerciseName: string;
  /** « 2:15 », « 400 m ». */
  main: string;
  /** « Plus longue distance · 1:45 · il y a 3 j ». */
  detail: string;
  achievedAt: string;
}

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
  return weightKg % 1 === 0 ? `${weightKg} kg` : `${loc(weightKg.toFixed(1))} kg`;
}

const TIER_LABELS_FR: Record<StrengthTier, string> = {
  beginner: 'Débutant',
  novice: 'Novice',
  intermediate: 'Intermédiaire',
  advanced: 'Avancé',
  elite: 'Elite',
};

interface SbdRecords {
  squat: number;
  bench: number;
  deadlift: number;
}

function detectLiftCategory(name: string): keyof SbdRecords | null {
  const n = name.toLowerCase();
  if (/squat/.test(n) && !/front|hack|goblet|split/.test(n)) return 'squat';
  if (/(bench[\s-]?press|developpe[\s-]?couche|d[ée]velopp[ée][\s-]?couch[ée])/.test(n))
    return 'bench';
  if (/(deadlift|souleve[\s-]?de[\s-]?terre|s[ou]l[èe]v[ée][\s-]?de[\s-]?terre)/.test(n))
    return 'deadlift';
  return null;
}

export function records() {
  return {
    loading: true,
    records: [] as DisplayRecord[],
    timedRecords: [] as TimedDisplayRecord[],
    sort: 'recent' as 'e1rm' | 'recent' | 'name',

    // ─── Strength scores ────────────────────────────────────────
    scoreBodyweightKg: 0,
    scoreSex: 'male' as StrengthSex,
    showScoresEditor: false,

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

    /** Médaillon d'un record : or pour le meilleur e1RM, accent si récent. */
    medalClass(r: DisplayRecord): string {
      if (this.records.length > 0 && Math.round(r.e1rmKg) === this.topE1rm) {
        return 'bg-gradient-to-br from-kinetic-gold to-kinetic-neon text-kinetic-on-accent';
      }
      if (r.isRecent)
        return 'bg-gradient-to-br from-kinetic-neon to-kinetic-electric text-kinetic-on-accent';
      return 'bg-kinetic-neon/15 text-kinetic-neon';
    },

    /** Part du record dans le meilleur e1RM (0–100), pour la jauge de la carte. */
    recordBarStyle(r: DisplayRecord): string {
      const top = this.topE1rm;
      const pct = top > 0 ? Math.max(4, Math.min(100, Math.round((r.e1rmKg / top) * 100))) : 0;
      return `width: ${pct}%`;
    },

    get recentCount(): number {
      return this.records.filter((r) => r.isRecent).length;
    },

    get sbdTotalKg(): number {
      const sbd = this._sbdMaxByCategory();
      return Math.round((sbd.squat + sbd.bench + sbd.deadlift) * 10) / 10;
    },

    get sbdBreakdown(): SbdRecords {
      return this._sbdMaxByCategory();
    },

    get wilksScore(): number {
      return wilks2020(this.sbdTotalKg, this.scoreBodyweightKg, this.scoreSex);
    },

    get ipfGlScore(): number {
      return ipfGoodlift(this.sbdTotalKg, this.scoreBodyweightKg, this.scoreSex);
    },

    get dotsScoreValue(): number {
      return dotsScore(this.sbdTotalKg, this.scoreBodyweightKg, this.scoreSex);
    },

    get strengthTierLabel(): string {
      const tier = tierFromIpfGl(this.ipfGlScore);
      return TIER_LABELS_FR[tier];
    },

    get scoresReady(): boolean {
      return (
        this.scoreBodyweightKg > 0 &&
        this.sbdTotalKg > 0 &&
        (this.sbdBreakdown.squat > 0 ||
          this.sbdBreakdown.bench > 0 ||
          this.sbdBreakdown.deadlift > 0)
      );
    },

    _sbdMaxByCategory(): SbdRecords {
      const acc: SbdRecords = { squat: 0, bench: 0, deadlift: 0 };
      for (const r of this.records) {
        const cat = detectLiftCategory(r.exerciseName);
        if (!cat) continue;
        // On utilise l'e1RM comme estimation 1RM raisonnable
        if (r.e1rmKg > acc[cat]) acc[cat] = r.e1rmKg;
      }
      // Arrondi à 0.5 kg pour l'affichage
      return {
        squat: Math.round(acc.squat * 2) / 2,
        bench: Math.round(acc.bench * 2) / 2,
        deadlift: Math.round(acc.deadlift * 2) / 2,
      };
    },

    async setScoreBodyweight(value: string): Promise<void> {
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) return;
      this.scoreBodyweightKg = num;
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEYS.STRENGTH_SCORE_PROFILE, {
          bodyweightKg: num,
          sex: this.scoreSex,
        });
      } catch (err) {
        console.warn('[records] persist score profile failed:', err);
      }
    },

    async setScoreSex(sex: StrengthSex): Promise<void> {
      this.scoreSex = sex;
      try {
        const deps = await getDeps();
        await deps.storage.set(STORAGE_KEYS.STRENGTH_SCORE_PROFILE, {
          bodyweightKg: this.scoreBodyweightKg,
          sex,
        });
      } catch (err) {
        console.warn('[records] persist score profile failed:', err);
      }
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
        const [sessions, exercises, scoreProfile, bwEntries] = await Promise.all([
          loadSessions(deps.storage),
          loadExercises(deps.storage),
          deps.storage.get<{ bodyweightKg: number; sex: StrengthSex }>(
            STORAGE_KEYS.STRENGTH_SCORE_PROFILE,
          ),
          deps.storage.get<Array<{ weight: number }>>(STORAGE_KEYS.BODYWEIGHT_ENTRIES),
        ]);
        this.records = this._computeRecords(sessions, exercises);
        this.timedRecords = this._computeTimedRecords(sessions, exercises);
        if (scoreProfile && typeof scoreProfile === 'object') {
          this.scoreBodyweightKg = Number(scoreProfile.bodyweightKg) || 0;
          this.scoreSex = scoreProfile.sex === 'female' ? 'female' : 'male';
        } else if (Array.isArray(bwEntries) && bwEntries.length > 0) {
          // Fallback : pesée la plus récente (par date) du module bodyweight
          this.scoreBodyweightKg = currentBodyweightKg(bwEntries) ?? 0;
        }
      } catch (err) {
        console.error('[records] init failed:', err);
        notify('error', 'Impossible de charger les records.');
      } finally {
        this.loading = false;
      }
    },

    _computeTimedRecords(
      sessions: readonly WorkoutSession[],
      exercises: readonly Exercise[],
    ): TimedDisplayRecord[] {
      const byId = new Map(exercises.map((e) => [e.id, e]));
      const now = Date.now();
      return timedRecords(sessions).map((t): TimedDisplayRecord => {
        const ex = byId.get(t.exerciseId);
        const byDistance =
          t.distanceM > 0 &&
          (exerciseMeasure(ex ?? { id: t.exerciseId }) === 'distance' || !t.durationSec);
        const kg = t.weightKg > 0 ? ` · ${loc(t.weightKg)} kg` : '';
        const at = byDistance ? t.distanceAt : t.durationAt;
        return {
          exerciseId: t.exerciseId,
          exerciseName: ex?.name ?? t.exerciseId,
          main: byDistance ? formatDistance(t.distanceM) : formatDuration(t.durationSec),
          detail: byDistance
            ? `Plus longue distance${t.durationSec > 0 ? ` · meilleure durée ${formatDuration(t.durationSec)}` : ''} · ${formatDateLabel(at, now)}`
            : `Meilleure durée${kg} · ${formatDateLabel(at, now)}`,
          achievedAt: at,
        };
      });
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
          // Reps × charge seulement : les séries chronométrées ont leurs propres records.
          for (const set of loadSetsOf(entry.sets)) {
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
