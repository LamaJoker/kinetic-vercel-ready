/**
 * Défis — section « Défis » de la page Succès (`challengesPanel` : défis en
 * cours en anneaux, défis proposés, création d'un défi personnel, médailles des
 * défis réussis) et carte compacte du défi le plus proche sur l'accueil
 * (`challengeCard`). Chargés à la demande (lib/lazy-component.ts).
 *
 * Évaluation, récompense (célébration + XP, une seule fois) et stockage :
 * lib/challenges.ts ; logique : @kinetic/core challenges.domain.
 */
import {
  CHALLENGE_EMOJI,
  CUSTOM_CHALLENGE_XP,
  challengeTitle,
  closestChallenge,
  customTargetBounds,
  type ChallengeDef,
  type ChallengeMetric,
  type ChallengePeriod,
  type ChallengeProgress,
  type CompletedChallenge,
} from '@kinetic/core';
import type { Exercise } from '../lib/training/types';
import type { ContextMenuRequest } from '../lib/context-menu';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import {
  acceptChallenge,
  createChallenge,
  dropChallenge,
  refreshChallenges,
} from '../lib/challenges';

/** Métriques proposées à la création d'un défi personnel. */
export const CUSTOM_METRICS: ReadonlyArray<{ key: ChallengeMetric; label: string }> = [
  { key: 'sessions', label: 'Séances' },
  { key: 'reps', label: "Répétitions d'un exercice" },
  { key: 'tonnage', label: 'Tonnage (kg)' },
  { key: 'sets', label: 'Séries de travail' },
  { key: 'minutes', label: "Minutes d'entraînement" },
  { key: 'checkinStreak', label: "Check-ins d'affilée" },
  { key: 'waterDays', label: "Jours à l'objectif d'eau" },
];

/** Anneau de progression : variable CSS lue par .k-ring-value. */
export function challengeRingStyle(p: Pick<ChallengeProgress, 'ratio'>): string {
  return `--p: ${Math.round(Math.max(0, Math.min(1, p.ratio)) * 100)}`;
}

/** Couleur de l'anneau selon l'état. */
export function challengeTone(p: Pick<ChallengeProgress, 'state'>): string {
  if (p.state === 'done') return 'text-kinetic-teal';
  if (p.state === 'failed') return 'text-gray-500';
  return 'text-kinetic-neon';
}

/** Ordre d'affichage : en cours (les plus avancés d'abord), puis réussis, puis ratés. */
export function sortProgress(list: readonly ChallengeProgress[]): ChallengeProgress[] {
  const rank = { active: 0, upcoming: 1, done: 2, failed: 3 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || b.ratio - a.ratio);
}

export function challengesPanel() {
  return {
    ready: false,
    progress: [] as ChallengeProgress[],
    suggestions: [] as ChallengeDef[],
    completed: [] as CompletedChallenge[],
    exercises: [] as Exercise[],
    sheet: false,
    form: {
      metric: 'sessions' as ChallengeMetric,
      period: 'month' as ChallengePeriod,
      target: '',
      exerciseId: '',
    },
    formError: '',
    metrics: CUSTOM_METRICS,

    async init(): Promise<void> {
      await this.refresh();
    },

    async refresh(): Promise<void> {
      try {
        const snap = await refreshChallenges();
        this.progress = sortProgress(snap.progress);
        this.suggestions = snap.suggestions;
        this.completed = snap.completed;
        this.exercises = snap.exercises;
      } catch (err) {
        console.warn('[défis] lecture impossible :', err);
      }
      this.ready = true;
    },

    ringStyle(p: ChallengeProgress): string {
      return challengeRingStyle(p);
    },
    tone(p: ChallengeProgress): string {
      return challengeTone(p);
    },
    pct(p: ChallengeProgress): string {
      return `${Math.round(p.ratio * 100)}%`;
    },
    statusClass(p: ChallengeProgress): string {
      if (p.state === 'done') return 'text-kinetic-teal';
      return p.state === 'failed' ? 'text-gray-500' : 'text-gray-400';
    },
    originLabel(p: ChallengeProgress): string {
      const kind =
        p.def.origin === 'custom' ? 'Perso' : p.def.origin === 'auto' ? 'Auto' : 'Relevé';
      return `${kind} · +${p.xp} XP`;
    },

    suggestionTitle(d: ChallengeDef): string {
      return challengeTitle(d, new Date());
    },
    suggestionEmoji(d: ChallengeDef): string {
      return CHALLENGE_EMOJI[d.metric];
    },
    async accept(d: ChallengeDef): Promise<void> {
      hapticSuccess();
      await acceptChallenge(d);
      await this.refresh();
    },

    challengeMenu(menu: ContextMenuRequest, p: ChallengeProgress): void {
      // Les défis automatiques se renouvellent seuls : rien à abandonner.
      if (p.def.origin === 'auto') return;
      menu.show([
        {
          label: 'Abandonner le défi',
          icon: 'trash',
          danger: true,
          confirm: 'Abandonner',
          run: async () => {
            await dropChallenge(p.def.id);
            await this.refresh();
          },
        },
      ]);
    },

    // ─── Défi personnel ──────────────────────────────────────

    openCustom(): void {
      hapticLight();
      this.form = { metric: 'sessions', period: 'month', target: '', exerciseId: '' };
      this.formError = '';
      this.sheet = true;
    },
    close(): void {
      this.sheet = false;
    },
    setPeriod(period: ChallengePeriod): void {
      this.form.period = period;
    },
    periodPressed(period: ChallengePeriod): string {
      return this.form.period === period ? 'true' : 'false';
    },
    get needsExercise(): boolean {
      return this.form.metric === 'reps';
    },
    /** Exercices en répétitions déjà pratiqués. */
    get exerciseOptions(): Array<{ id: string; name: string }> {
      return this.exercises
        .filter((e) => !e.hidden && (e.measure ?? 'reps') === 'reps')
        .map((e) => ({ id: e.id, name: e.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    },
    get targetHint(): string {
      const { min, max } = customTargetBounds(this.form.metric, this.form.period);
      const unit = this.form.metric === 'tonnage' ? ' kg' : '';
      const reward = CUSTOM_CHALLENGE_XP[this.form.period];
      return `Entre ${min.toLocaleString('fr-FR')} et ${max.toLocaleString('fr-FR')}${unit} · +${reward} XP si réussi`;
    },
    async saveCustom(): Promise<void> {
      const ex = this.exercises.find((e) => e.id === this.form.exerciseId);
      const err = await createChallenge({
        metric: this.form.metric,
        period: this.form.period,
        target: Number(String(this.form.target).replace(',', '.')),
        ...(ex ? { exerciseId: ex.id, exerciseName: ex.name } : {}),
      });
      if (err) {
        this.formError = err;
        return;
      }
      hapticSuccess();
      this.sheet = false;
      await this.refresh();
    },

    // ─── Médailles ───────────────────────────────────────────

    medalCat(c: CompletedChallenge): string {
      return c.period === 'month' ? 'volume' : 'streak';
    },
    medalTier(c: CompletedChallenge): string {
      return c.period === 'month' ? '3' : '2';
    },
    medalDate(c: CompletedChallenge): string {
      const d = new Date(c.completedAt);
      return Number.isFinite(d.getTime())
        ? `Réussi le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
        : 'Réussi';
    },
  };
}

/** Accueil : le défi en cours le plus proche de la réussite. */
export function challengeCard() {
  return {
    current: null as ChallengeProgress | null,
    async init(): Promise<void> {
      try {
        const snap = await refreshChallenges();
        this.current = closestChallenge(snap.progress);
      } catch (err) {
        console.warn('[défis] accueil :', err);
      }
    },
    get title(): string {
      return this.current?.title ?? '';
    },
    get emoji(): string {
      return this.current?.emoji ?? '';
    },
    get detail(): string {
      return this.current ? `${this.current.progressLabel} · ${this.current.statusLabel}` : '';
    },
    get ringStyle(): string {
      return this.current ? challengeRingStyle(this.current) : '--p: 0';
    },
  };
}
