/**
 * weekPlan — planning de la semaine du programme suivi (accueil en version
 * compacte `data-compact`, /program en version complète avec déplacements).
 * Chargé à la demande (lib/lazy-component.ts) ; logique dans @kinetic/core
 * (week-plan.domain) et lib/program-week.ts.
 *
 * Émet `k-plan-today` sur window : { name, done, template } — la séance prévue
 * aujourd'hui, pour « Séance du jour » (accueil) et le focus du jour (/program).
 */
import { STORAGE_KEYS, moveTargets, PLAN_DAY_NAMES, type PlanItem } from '@kinetic/core';
import { getDeps } from '../deps';
import {
  loadProgramWeek,
  loadTemplates,
  saveProgramWeekAdjust,
  templateForToday,
  type ProgramWeekView,
} from '../lib/program-week';
import { hapticLight, hapticSuccess } from '../lib/haptics';

export interface PlanTodayDetail {
  name: string | null;
  /** Page du programme suivi : '/program' (découpage) ou '/programs' (catalogue). */
  program: string;
  done: boolean;
  /** Séances faites / prévues cette semaine. */
  doneCount: number;
  total: number;
  template: { id: string; name: string; exerciseCount: number; setCount: number } | null;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function weekPlan() {
  return {
    compact: false,
    view: null as ProgramWeekView | null,
    sheetOpen: false,
    sheetKey: null as string | null,
    sheetDay: null as number | null,

    async init(): Promise<void> {
      this.compact = (this as unknown as { $el: HTMLElement }).$el.hasAttribute('data-compact');
      try {
        const deps = await getDeps();
        this.view = await loadProgramWeek(deps.storage);
        await this._announce(true);
      } catch (err) {
        console.warn('[week-plan] planning indisponible :', err);
      }
    },

    get title(): string {
      return this.view ? this.view.title : '';
    },
    get subtitle(): string {
      return this.view ? this.view.subtitle : '';
    },
    get href(): string {
      return this.view ? this.view.href : '/program';
    },
    get summary(): string {
      const p = this.view?.plan;
      return p ? `${p.doneCount} / ${p.total} séances` : '';
    },
    /** Messages : ↷ séance déplacée, ! semaine trop entamée / repos trop court. */
    get messages(): Array<{ text: string; icon: string }> {
      const m = (this.view?.plan.messages ?? []).map((text) => ({
        text,
        icon: /^(Semaine|Attention)/.test(text) ? '!' : '↷',
      }));
      return this.compact ? m.slice(0, 2) : m;
    },
    get unplaced(): PlanItem[] {
      return this.view?.plan.items.filter((i) => i.status === 'unplaced') ?? [];
    },
    get skipped(): PlanItem[] {
      return this.view?.plan.items.filter((i) => i.status === 'skipped') ?? [];
    },

    /** Cases du planning (lundi → dimanche). */
    get cells() {
      return (this.view?.plan.days ?? []).map((d) => {
        const it = d.item;
        const mark = it?.status === 'done' ? '✓' : it?.status === 'moved' ? '↷' : '';
        let cls = 'bg-white/5 text-gray-500';
        if (it?.status === 'done') cls = 'bg-kinetic-teal text-kinetic-on-accent';
        else if (it?.status === 'moved')
          cls = 'bg-kinetic-neon/15 text-kinetic-neon ring-1 ring-inset ring-kinetic-neon';
        else if (it) cls = 'bg-kinetic-elevated text-white';
        if (d.isToday && it && it.status !== 'done' && it.status !== 'moved') {
          cls += ' ring-2 ring-inset ring-kinetic-neon';
        }
        if (d.unavailable && !it) cls = 'bg-transparent text-gray-600 line-through';
        const what = it
          ? `${it.name}${it.status === 'done' ? ', faite' : it.status === 'moved' ? ', déplacée' : ', prévue'}`
          : d.unavailable
            ? 'indisponible'
            : 'repos';
        return {
          day: d.day,
          short: d.short,
          name: it ? it.name : d.unavailable ? 'indispo' : '',
          mark: mark || (it ? it.name.charAt(0) : d.unavailable ? '×' : '·'),
          cls,
          dayCls: d.isToday ? 'text-kinetic-neon font-bold' : 'text-gray-500 font-medium',
          aria: `${cap(d.name)}${d.isToday ? " (aujourd'hui)" : ''} : ${what}`,
        };
      });
    },

    // ─── Feuille : déplacer / sauter / jour indisponible (/program) ───────────

    get sheetItem(): PlanItem | null {
      return this.view?.plan.items.find((i) => i.key === this.sheetKey) ?? null;
    },
    get sheetTitle(): string {
      const it = this.sheetItem;
      if (it) return it.name;
      return this.sheetDay === null ? '' : cap(PLAN_DAY_NAMES[this.sheetDay] ?? '');
    },
    get sheetStatus(): string {
      const it = this.sheetItem;
      if (!it) return 'Pas de séance prévue ce jour-là.';
      const base = PLAN_DAY_NAMES[it.baseDay];
      if (it.status === 'done') return `Faite ${PLAN_DAY_NAMES[it.day ?? 0]}.`;
      if (it.status === 'skipped') return `Sautée cette semaine (prévue ${base}).`;
      if (it.status === 'unplaced')
        return `Prévue ${base} : plus de jour libre avec assez de repos.`;
      if (it.status === 'moved')
        return `Prévue ${base}, déplacée à ${PLAN_DAY_NAMES[it.day ?? 0]}.`;
      return `Prévue ${base}.`;
    },
    get canEditItem(): boolean {
      const it = this.sheetItem;
      return !!it && it.status !== 'done';
    },
    get canReset(): boolean {
      const it = this.sheetItem;
      return !!it && (it.manual || it.status === 'skipped');
    },
    get canSkip(): boolean {
      const it = this.sheetItem;
      return !!it && it.status !== 'done' && it.status !== 'skipped';
    },
    get targets(): Array<{ day: number; label: string; current: boolean }> {
      const v = this.view;
      const it = this.sheetItem;
      if (!v || !it || it.status === 'done') return [];
      return moveTargets(v.plan, it.key, v.today).map((day) => ({
        day,
        label: cap(PLAN_DAY_NAMES[day] ?? '').slice(0, 3) + '.',
        current: it.day === day,
      }));
    },
    get canToggleDay(): boolean {
      return this.sheetDay !== null && !!this.view && this.sheetDay >= this.view.today;
    },
    get dayUnavailable(): boolean {
      return (
        this.sheetDay !== null && (this.view?.adjust.unavailable ?? []).includes(this.sheetDay)
      );
    },
    get toggleDayLabel(): string {
      return this.dayUnavailable
        ? 'Je suis disponible ce jour-là'
        : 'Je ne suis pas disponible ce jour-là';
    },
    targetPressed(t: { current: boolean }): string {
      return t.current ? 'true' : 'false';
    },
    /** Jour actuel de la séance : bouton plein (corail). */
    targetClass(t: { current: boolean }): string {
      return t.current ? 'k-pill-accent' : 'k-pill';
    },

    openDay(day: number): void {
      if (this.compact || !this.view) return;
      const item = this.view.plan.days[day]?.item ?? null;
      this.sheetKey = item ? item.key : null;
      this.sheetDay = day;
      this.sheetOpen = true;
      hapticLight();
    },
    openItem(key: string): void {
      this.sheetKey = key;
      this.sheetDay = null;
      this.sheetOpen = true;
      hapticLight();
    },
    close(): void {
      this.sheetOpen = false;
    },

    moveTo(day: number): Promise<void> {
      return this._edit([this.sheetKey ?? ''], day, `${this.sheetTitle} : ${PLAN_DAY_NAMES[day]}`);
    },
    resetItem(): Promise<void> {
      return this._edit([this.sheetKey ?? ''], null, `${this.sheetTitle} : comme prévu`);
    },
    skipItem(): Promise<void> {
      return this._edit([this.sheetKey ?? ''], 'skip', `${this.sheetTitle} sautée cette semaine`);
    },
    skipUnplaced(): Promise<void> {
      const keys = this.unplaced.map((i) => i.key);
      return this._edit(keys, 'skip', 'Séances sautées : la semaine prochaine repart normalement');
    },
    toggleDay(): Promise<void> {
      const v = this.view;
      const day = this.sheetDay;
      if (!v || day === null) return Promise.resolve();
      const cur = v.adjust.unavailable ?? [];
      const off = cur.includes(day);
      return this._save(
        { ...v.adjust, unavailable: off ? cur.filter((d) => d !== day) : [...cur, day] },
        `${cap(PLAN_DAY_NAMES[day] ?? '')} : ${off ? 'disponible' : 'indisponible'}`,
      );
    },

    /** Séances `keys` : déplacées à `day`, remises comme prévu (null) ou sautées. */
    _edit(keys: string[], day: number | null | 'skip', message: string): Promise<void> {
      const v = this.view;
      if (!v || keys.length === 0) return Promise.resolve();
      const moves = { ...(v.adjust.moves ?? {}) };
      let skipped = (v.adjust.skipped ?? []).filter((k) => !keys.includes(k));
      for (const k of keys) {
        delete moves[k];
        if (typeof day === 'number') moves[k] = day;
      }
      if (day === 'skip') skipped = [...skipped, ...keys];
      return this._save({ ...v.adjust, moves, skipped }, message);
    },

    async _save(adjust: ProgramWeekView['adjust'], message: string): Promise<void> {
      const v = this.view;
      if (!v) return;
      try {
        const deps = await getDeps();
        this.view = await saveProgramWeekAdjust(deps.storage, v, adjust);
        this.sheetOpen = false;
        hapticSuccess();
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, { detail: { kind: 'success', message } }),
        );
        await this._announce(false);
      } catch (err) {
        console.error('[week-plan] enregistrement impossible :', err);
        window.dispatchEvent(
          new CustomEvent(STORAGE_KEYS.EVENT_NOTIFY, {
            detail: { kind: 'error', message: 'Planning non enregistré. Réessaie.' },
          }),
        );
      }
    },

    /** Prévient la page (Séance du jour / focus du jour) de la séance prévue aujourd'hui. */
    async _announce(withTemplate: boolean): Promise<void> {
      const v = this.view;
      if (!v) return;
      const it = v.plan.days[v.today]?.item ?? null;
      const detail: PlanTodayDetail = {
        name: it ? it.name : null,
        program: v.href,
        done: it?.status === 'done',
        doneCount: v.plan.doneCount,
        total: v.plan.total,
        template: null,
      };
      if (withTemplate && this.compact && v.plan.today) {
        const deps = await getDeps();
        const t = templateForToday(v, await loadTemplates(deps.storage));
        if (t) {
          detail.template = {
            id: t.id,
            name: t.name,
            exerciseCount: t.exercises.length,
            setCount: t.exercises.reduce((n, e) => n + e.sets, 0),
          };
        }
      }
      window.dispatchEvent(new CustomEvent('k-plan-today', { detail }));
    },
  };
}
