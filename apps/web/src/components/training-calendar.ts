/**
 * Calendrier du mois — composant Alpine imbriqué dans Séances › Historique,
 * chargé à la demande (lib/lazy-component.ts). Les séances et exercices viennent
 * de la page via `x-effect="sync(sessions, exercises)"`.
 *
 * Grille lundi → dimanche, pastille colorée par type de séance, aujourd'hui
 * entouré, mois précédent / suivant (boutons ou glisser horizontal), toucher un
 * jour affiche ses séances. Calculs : packages/core training-calendar.domain.
 */
import {
  SESSION_KIND_LABELS,
  SESSION_KIND_ORDER,
  buildMonthCalendar,
  formatSetsShort,
  localDateKey,
  sessionKind,
  sessionTonnageKg,
  sessionsOnDay,
  shiftMonth,
  workSetsOf,
  warmupSetsOf,
  type CalendarDay,
  type MonthCalendar,
  type SessionKind,
} from '@kinetic/core';
import type { Exercise, WorkoutSession } from '../lib/training/types';
import { formatTonnage } from './visual-format';
import './visual-views.css';

export { formatTonnage };

export const WEEKDAYS_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const;

/** Classes d'une case du calendrier. */
export function dayClasses(day: CalendarDay, selected: string | null): string {
  const c = ['k-cal-day'];
  if (!day.inMonth) c.push('k-cal-out');
  else if (day.isFuture) c.push('k-cal-future');
  if (day.kinds.length > 0) c.push('k-cal-on', `k-kind-${day.kinds[0]}`);
  if (day.isToday) c.push('k-cal-today');
  if (selected === day.date) c.push('k-cal-sel');
  return c.join(' ');
}

/** « mardi 3 novembre, 1 séance (Push) » : nom accessible d'une case. */
export function dayAriaLabel(day: CalendarDay): string {
  const [y, m, d] = day.date.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const n = day.kinds.length;
  if (n === 0) return day.isToday ? `${date}, aujourd’hui` : date;
  const kinds = [...new Set(day.kinds)].map((k) => SESSION_KIND_LABELS[k]).join(', ');
  return `${date}, ${n} séance${n > 1 ? 's' : ''} (${kinds})${day.isToday ? ', aujourd’hui' : ''}`;
}

export interface DaySessionView {
  id: string;
  name: string;
  kind: SessionKind;
  kindLabel: string;
  time: string;
  meta: string;
  exercises: Array<{ key: string; name: string; sets: string }>;
}

/** Lecture d'une séance pour le panneau du jour. */
export function daySessionView(
  s: WorkoutSession,
  kind: SessionKind,
  exerciseName: (id: string) => string,
): DaySessionView {
  const time = new Date(s.startedAt).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const meta = [
    s.durationMin ? `${s.durationMin} min` : '',
    formatTonnage(sessionTonnageKg(s)),
    s.caloriesKcal ? `~${s.caloriesKcal} kcal` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: s.id,
    name: s.name,
    kind,
    kindLabel: SESSION_KIND_LABELS[kind],
    time,
    meta,
    exercises: s.entries
      .map((e, i) => {
        const work = workSetsOf(e.sets);
        const warm = warmupSetsOf(e.sets).length;
        const sets = work.length
          ? formatSetsShort(work) + (warm ? ` (+${warm} échauff.)` : '')
          : warm
            ? `${warm} échauff.`
            : '';
        return { key: `${i}-${e.exerciseId}`, name: exerciseName(e.exerciseId), sets };
      })
      .filter((e) => e.sets !== ''),
  };
}

export function trainingCalendar() {
  const today = new Date();
  // Mémo hors état réactif : le calendrier est relu par de nombreuses liaisons.
  let memo: { key: string; sessions: unknown; value: MonthCalendar } | null = null;

  return {
    year: today.getFullYear(),
    month: today.getMonth(),
    selectedDate: null as string | null,
    /** Sens de la dernière bascule (animation). */
    slide: '' as '' | 'next' | 'prev',
    weekdays: WEEKDAYS_FR,
    _sessions: [] as WorkoutSession[],
    _exercises: [] as Exercise[],
    _touch: null as { x: number; y: number } | null,

    sync(sessions: WorkoutSession[] | undefined, exercises: Exercise[] | undefined): void {
      this._sessions = sessions ?? [];
      this._exercises = exercises ?? [];
    },

    _musclesOf(id: string): readonly string[] {
      return this._exercises.find((e) => e.id === id)?.muscles ?? [];
    },

    get cal(): MonthCalendar {
      const now = new Date();
      const key = `${this.year}-${this.month}-${this._sessions.length}-${this._exercises.length}-${localDateKey(now)}`;
      if (memo && memo.key === key && memo.sessions === this._sessions) return memo.value;
      const value = buildMonthCalendar({
        sessions: this._sessions,
        musclesOf: (id) => this._musclesOf(id),
        year: this.year,
        month: this.month,
        now,
      });
      memo = { key, sessions: this._sessions, value };
      return value;
    },

    // ─── Navigation ──────────────────────────────────────────

    _go(delta: number): void {
      const m = shiftMonth(this.year, this.month, delta);
      this.year = m.year;
      this.month = m.month;
      this.slide = delta > 0 ? 'next' : 'prev';
      this.selectedDate = null;
    },
    prevMonth(): void {
      this._go(-1);
    },
    nextMonth(): void {
      if (this.canGoNext()) this._go(1);
    },
    /** Pas de mois futur : rien à y voir. */
    canGoNext(): boolean {
      const now = new Date();
      return this.year * 12 + this.month < now.getFullYear() * 12 + now.getMonth();
    },
    isCurrentMonth(): boolean {
      const now = new Date();
      return this.year === now.getFullYear() && this.month === now.getMonth();
    },
    goToday(): void {
      const now = new Date();
      const back = this.year * 12 + this.month > now.getFullYear() * 12 + now.getMonth();
      this.year = now.getFullYear();
      this.month = now.getMonth();
      this.slide = back ? 'prev' : 'next';
      this.selectedDate = localDateKey(now);
    },
    /** Clé du mois affiché : la grille est recréée (et animée) à chaque bascule. */
    monthKeys(): string[] {
      return [`${this.year}-${this.month}`];
    },
    /** Cases de la grille, semaine après semaine (lundi → dimanche). */
    get days(): CalendarDay[] {
      return this.cal.weeks.flat();
    },
    gridClass(): string {
      return this.slide ? `k-cal-grid k-cal-anim-${this.slide}` : 'k-cal-grid';
    },

    onTouchStart(e: TouchEvent): void {
      const t = e.touches[0];
      // Bord gauche : réservé au geste « retour » de l'app.
      this._touch = t && t.clientX > 28 ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd(e: TouchEvent): void {
      const start = this._touch;
      this._touch = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) this.nextMonth();
      else this.prevMonth();
    },

    // ─── Jours ───────────────────────────────────────────────

    dayClass(day: CalendarDay): string {
      return dayClasses(day, this.selectedDate);
    },
    isPicked(day: CalendarDay): string {
      return this.selectedDate === day.date ? 'true' : 'false';
    },
    dayLabel(day: CalendarDay): string {
      return dayAriaLabel(day);
    },
    dots(day: CalendarDay): Array<{ key: string; cls: string }> {
      return day.kinds
        .slice(0, 3)
        .map((k, i) => ({ key: `${i}${k}`, cls: `k-cal-dot k-kind-${k}` }));
    },
    pick(day: CalendarDay): void {
      if (!day.inMonth) {
        const [y, m] = day.date.split('-').map(Number) as [number, number];
        const delta = y * 12 + m - 1 - (this.year * 12 + this.month);
        if (delta > 0 && !this.canGoNext()) return;
        this._go(delta);
      }
      this.selectedDate = this.selectedDate === day.date && day.inMonth ? null : day.date;
    },

    get selectedLabel(): string {
      if (!this.selectedDate) return '';
      const [y, m, d] = this.selectedDate.split('-').map(Number) as [number, number, number];
      const label = new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
      return label.charAt(0).toUpperCase() + label.slice(1);
    },

    get daySessions(): DaySessionView[] {
      if (!this.selectedDate) return [];
      const name = (id: string): string => this._exercises.find((e) => e.id === id)?.name ?? id;
      return sessionsOnDay(this._sessions, this.selectedDate).map((s) =>
        daySessionView(
          s,
          sessionKind(s, (id) => this._musclesOf(id)),
          name,
        ),
      );
    },

    // ─── Résumé et légende ───────────────────────────────────

    summaryTonnage(): string {
      return formatTonnage(this.cal.summary.tonnageKg);
    },
    /** Types présents ce mois-ci (légende). */
    legend(): Array<{ kind: SessionKind; label: string; count: number; cls: string }> {
      const by = this.cal.summary.byKind;
      return SESSION_KIND_ORDER.filter((k) => by[k] > 0).map((k) => ({
        kind: k,
        label: SESSION_KIND_LABELS[k],
        count: by[k],
        cls: `k-kind-chip k-kind-${k}`,
      }));
    },
    kindChip(kind: SessionKind): string {
      return `k-kind-chip k-kind-${kind}`;
    },
  };
}
