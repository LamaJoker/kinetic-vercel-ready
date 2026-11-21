/**
 * Page Outils (/outils) : calculateur de 1RM, table de pourcentages arrondie aux
 * disques (réglages de « Chargement de barre »), table RPE et charge pour X reps
 * à RPE Y. Toute la logique est dans @kinetic/core (strength-tools.domain).
 */
import {
  STORAGE_KEYS,
  workSetsOf,
  estimateOneRm,
  percentTable,
  rpeTable,
  loadForRpe,
  knownE1rmByExercise,
  RPE_TABLE_RPES,
  type BarSetup,
  type E1rmSet,
  type OneRmEstimate,
  type PercentRow,
  type RpeLoad,
} from '@kinetic/core';
import { getDeps } from '../deps';
import { loadExercises, loadSessions } from '../lib/training/storage';

type ToolTab = 'rm' | 'pct' | 'rpe';

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function toolsPage() {
  return {
    tab: 'rm' as ToolTab,
    weight: 100,
    reps: 5,
    /** Max de référence (1RM) des tables. */
    oneRm: 100,
    targetReps: 5,
    targetRpe: 8,
    exerciseId: '',
    known: [] as Array<{ id: string; name: string; e1rm: number; increment: number | null }>,
    setup: { barKg: 20 } as BarSetup,
    RPES: RPE_TABLE_RPES,
    RPE_ROWS: rpeTable(),

    async init(): Promise<void> {
      const tab = new URLSearchParams(window.location?.search ?? '').get('tab');
      if (tab === 'pct' || tab === 'rpe') this.tab = tab;
      try {
        const deps = await getDeps();
        const [prefs, exercises, sessions] = await Promise.all([
          deps.storage.get<{ barKg?: number; enabledPlates?: number[] }>(STORAGE_KEYS.PLATE_PREFS),
          loadExercises(deps.storage),
          loadSessions(deps.storage),
        ]);
        if (prefs)
          this.setup = {
            barKg: prefs.barKg ?? 20,
            ...(prefs.enabledPlates ? { plates: prefs.enabledPlates } : {}),
          };
        const sets: E1rmSet[] = sessions.flatMap((s) =>
          s.entries.flatMap((e) =>
            workSetsOf(e.sets).map((x) => ({ ...x, exerciseId: e.exerciseId })),
          ),
        );
        const byId = new Map(exercises.map((e) => [e.id, e]));
        this.known = [...knownE1rmByExercise(sets, new Date())]
          .map(([id, e1rm]) => {
            const ex = byId.get(id);
            // Barre (ou inconnu) : disques ; sinon pas de charge de l'exercice.
            const increment = ex && ex.equipment !== 'barbell' ? ex.incrementKg || 1 : null;
            return { id, name: ex?.name ?? id, e1rm, increment };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
      } catch (err) {
        console.warn('[outils] init failed:', err);
      }
    },

    setTab(t: ToolTab): void {
      this.tab = t;
    },

    /** Exercice choisi : son e1RM connu devient le max des tables. */
    pickExercise(): void {
      const hit = this.known.find((k) => k.id === this.exerciseId);
      if (hit) this.oneRm = hit.e1rm;
    },

    get estimate(): OneRmEstimate | null {
      return estimateOneRm(this.weight, this.reps);
    },

    /** Le calcul de 1RM devient le max des tables (onglets % et RPE). */
    useEstimate(): void {
      const e = this.estimate;
      if (!e) return;
      this.oneRm = e.average;
      this.exerciseId = '';
      this.tab = 'pct';
    },

    /** Arrondi : disques de la barre, ou pas de l'exercice choisi (haltères, machine). */
    get rounding(): BarSetup {
      const inc = this.known.find((k) => k.id === this.exerciseId)?.increment;
      return inc ? { barKg: 0, incrementKg: inc } : this.setup;
    },

    get roundingLabel(): string {
      const inc = this.rounding.incrementKg;
      return inc
        ? `Charges arrondies au pas de l'exercice (${inc} kg).`
        : `Charges arrondies aux disques de « Chargement de barre » (barre de ${this.setup.barKg} kg).`;
    },

    get pctRows(): PercentRow[] {
      return percentTable(this.oneRm, this.rounding);
    },

    get rpeLoad(): RpeLoad | null {
      return loadForRpe(this.oneRm, this.targetReps, this.targetRpe, this.rounding);
    },

    stepWeight(d: number): void {
      this.weight = clamp(r2((Number(this.weight) || 0) + d), 0, 1000);
    },
    stepReps(d: number): void {
      this.reps = clamp(Math.round((Number(this.reps) || 0) + d), 1, 20);
    },
    stepMax(d: number): void {
      this.oneRm = clamp(r2((Number(this.oneRm) || 0) + d), 0, 1000);
    },
    stepTargetReps(d: number): void {
      this.targetReps = clamp(Math.round((Number(this.targetReps) || 0) + d), 1, 12);
    },
    stepRpe(d: number): void {
      this.targetRpe = clamp((Number(this.targetRpe) || 8) + d, 6, 10);
    },

    /** Case de la table RPE touchée : reps × RPE deviennent la cible. */
    pickCell(reps: number, rpe: number): void {
      this.targetReps = reps;
      this.targetRpe = rpe;
    },
    isCell(reps: number, rpe: number): boolean {
      return this.targetReps === reps && this.targetRpe === rpe;
    },

    fmt(n: number): string {
      return n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    },
  };
}
