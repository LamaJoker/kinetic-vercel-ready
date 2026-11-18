/**
 * Célébrations — carte en verre flottante, médaille sur ressort et éclats
 * d'accent quand un record est battu, un niveau gagné ou la routine du jour
 * complétée. Montée une seule fois dans la coquille (index.html :
 * `<div x-data="celebration">`), styles dans styles/celebrations.css.
 *
 * Déclenchement : `celebrate(detail)` émet EVENT_CELEBRATE sur window ;
 * EVENT_LEVELUP (stores/vitalite.ts, stores/goals.ts) est écouté directement.
 *
 * Règles :
 *   - une seule carte à la fois, les suivantes attendent (file courte, sans
 *     doublon consécutif, plafonnée à MAX_QUEUE) ;
 *   - ~2,4 s puis disparition ; toucher la carte ou Échap ferme tout de suite ;
 *   - ne bloque jamais la saisie : seule la carte capte le toucher ;
 *   - une vibration « célébration » par carte affichée, jamais en boucle ;
 *   - coupé pendant le chargement de la démo (`setCelebrationsMuted`) et tant
 *     que l'utilisateur n'a pas encore touché l'écran depuis le lancement :
 *     rien au démarrage (démo rechargée, santé synchronisée, rattrapage d'XP) ;
 *   - prefers-reduced-motion : simple fondu, sans particules (CSS).
 */
import { STORAGE_KEYS } from '@kinetic/core';
import { hapticCelebrate } from './haptics';

export type CelebrationKind = 'record' | 'level' | 'routine';

export interface CelebrationDetail {
  kind: CelebrationKind;
  /** Ligne principale (« Nouveau record ! », « Niveau 6 atteint »). */
  title: string;
  /** Ligne secondaire (« Squat 120 kg × 5 »), facultative. */
  subtitle?: string;
  /** Texte de la médaille pour un niveau (« 6 »). */
  badge?: string;
}

/** Durée d'affichage d'une carte avant sa sortie automatique. */
export const CELEBRATION_MS = 2400;
/** Durée de l'animation de sortie (doit suivre styles/celebrations.css). */
export const CELEBRATION_EXIT_MS = 240;
/** Cartes en attente au plus : au-delà, les plus récentes sont ignorées. */
export const MAX_QUEUE = 3;
/** Nombre d'éclats autour de la médaille. */
export const PARTICLE_COUNT = 12;

const fmtKg = (kg: number): string =>
  kg.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ');

/** « Nouveau record ! » — « Squat 120 kg × 5 » (ou « Tractions × 12 » au poids du corps). */
export function recordCelebration(
  exerciseName: string,
  weightKg: number,
  reps: number,
): CelebrationDetail {
  const name = exerciseName.trim();
  // Espaces insécables : la performance ne se coupe jamais en fin de ligne.
  const perf = weightKg > 0 ? `${fmtKg(weightKg)}\u00a0kg\u00a0×\u00a0${reps}` : `×\u00a0${reps}`;
  return { kind: 'record', title: 'Nouveau record !', subtitle: name ? `${name} ${perf}` : perf };
}

/** « Niveau 6 atteint » — récompense débloquée en sous-titre s'il y en a une. */
export function levelCelebration(level: number, rewardTitle = ''): CelebrationDetail {
  const reward = rewardTitle.trim();
  return {
    kind: 'level',
    title: `Niveau ${level} atteint`,
    subtitle: reward ? `Récompense débloquée\u00a0: ${reward}` : 'Continue sur ta lancée',
    badge: String(level),
  };
}

/** « Routine du jour complète » — « 5 sur 5 · 100 % ». */
export function routineCelebration(total: number): CelebrationDetail {
  return {
    kind: 'routine',
    title: 'Routine du jour complète',
    subtitle: `${total} sur ${total} · 100\u00a0%`,
  };
}

// ─── Coupure (chargement de la démo) ─────────────────────────────────────────

let muted = false;

/** Coupe / rétablit les célébrations (chargement des données de démo). */
export function setCelebrationsMuted(on: boolean): void {
  muted = on;
}

export function celebrationsMuted(): boolean {
  return muted;
}

/** Demande une célébration. Ne fait rien hors navigateur ou si coupé. */
export function celebrate(detail: CelebrationDetail): void {
  if (muted || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_CELEBRATE, { detail }));
}

// ─── File d'attente (logique pure, testée) ───────────────────────────────────

const sameAs = (a: CelebrationDetail | null | undefined, b: CelebrationDetail): boolean =>
  !!a && a.kind === b.kind && a.title === b.title && a.subtitle === b.subtitle;

/**
 * Ajoute `next` à la file si ce n'est ni un doublon de la carte affichée ou
 * de la dernière en attente, ni un débordement. Renvoie la nouvelle file.
 */
export function enqueueCelebration(
  queue: readonly CelebrationDetail[],
  current: CelebrationDetail | null,
  next: CelebrationDetail,
): CelebrationDetail[] {
  const last = queue.length > 0 ? queue[queue.length - 1] : current;
  if (sameAs(last, next)) return [...queue];
  if (queue.length >= MAX_QUEUE) return [...queue];
  return [...queue, next];
}

/** Valide un detail reçu par événement (vient de window : on ne fait pas confiance). */
export function asCelebration(raw: unknown): CelebrationDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<CelebrationDetail>;
  if (d.kind !== 'record' && d.kind !== 'level' && d.kind !== 'routine') return null;
  if (typeof d.title !== 'string' || d.title === '') return null;
  return {
    kind: d.kind,
    title: d.title,
    ...(typeof d.subtitle === 'string' && d.subtitle ? { subtitle: d.subtitle } : {}),
    ...(typeof d.badge === 'string' && d.badge ? { badge: d.badge } : {}),
  };
}

// ─── Composant Alpine (coquille) ─────────────────────────────────────────────

type Timer = ReturnType<typeof setTimeout>;

interface CelebrationState {
  _armed: boolean;
  current: CelebrationDetail | null;
  leaving: boolean;
  queue: CelebrationDetail[];
  _timer: Timer | null;
  _onCelebrate: ((e: Event) => void) | null;
  _onLevelUp: ((e: Event) => void) | null;
  $el: HTMLElement;
  push(detail: CelebrationDetail): void;
  _showNext(): void;
  dismiss(): void;
}

export function celebration() {
  return {
    /** Vrai après le premier toucher / la première touche depuis le lancement. */
    _armed: false,
    current: null as CelebrationDetail | null,
    leaving: false,
    queue: [] as CelebrationDetail[],
    _timer: null as Timer | null,
    _onCelebrate: null as ((e: Event) => void) | null,
    _onLevelUp: null as ((e: Event) => void) | null,

    init(this: CelebrationState): void {
      // Éclats : générés ici pour garder index.html court. Chaque éclat part
      // dans sa direction (--k-cel-a) à sa distance (--k-cel-d).
      const burst = this.$el.querySelector('.k-cel-burst');
      if (burst && burst.childElementCount === 0) {
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const p = document.createElement('i');
          p.style.setProperty('--k-cel-a', `${Math.round((360 / PARTICLE_COUNT) * i + 8)}deg`);
          p.style.setProperty('--k-cel-d', `${i % 2 === 0 ? 52 : 40}px`);
          burst.appendChild(p);
        }
      }
      this._onCelebrate = (e: Event) => {
        const detail = asCelebration((e as CustomEvent).detail);
        if (detail) this.push(detail);
      };
      this._onLevelUp = (e: Event) => {
        const d = (e as CustomEvent<{ level?: unknown; title?: unknown }>).detail;
        const level = Number(d?.level);
        if (!Number.isFinite(level) || level <= 0) return;
        this.push(levelCelebration(level, typeof d?.title === 'string' ? d.title : ''));
      };
      const arm = (): void => {
        this._armed = true;
        window.removeEventListener('pointerdown', arm, true);
        window.removeEventListener('keydown', arm, true);
      };
      window.addEventListener('pointerdown', arm, true);
      window.addEventListener('keydown', arm, true);
      window.addEventListener(STORAGE_KEYS.EVENT_CELEBRATE, this._onCelebrate);
      window.addEventListener(STORAGE_KEYS.EVENT_LEVELUP, this._onLevelUp);
    },

    destroy(this: CelebrationState): void {
      if (this._onCelebrate)
        window.removeEventListener(STORAGE_KEYS.EVENT_CELEBRATE, this._onCelebrate);
      if (this._onLevelUp) window.removeEventListener(STORAGE_KEYS.EVENT_LEVELUP, this._onLevelUp);
      if (this._timer) clearTimeout(this._timer);
    },

    push(this: CelebrationState, detail: CelebrationDetail): void {
      if (muted || !this._armed) return;
      this.queue = enqueueCelebration(this.queue, this.current, detail);
      if (!this.current) this._showNext();
    },

    _showNext(this: CelebrationState): void {
      const next = this.queue[0];
      this.queue = this.queue.slice(1);
      this.leaving = false;
      this.current = next ?? null;
      if (!next) return;
      hapticCelebrate();
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this.dismiss(), CELEBRATION_MS);
    },

    /** Toucher la carte, Échap ou fin du délai : sortie puis carte suivante. */
    dismiss(this: CelebrationState): void {
      if (!this.current || this.leaving) return;
      if (this._timer) clearTimeout(this._timer);
      this.leaving = true;
      this._timer = setTimeout(() => {
        this.current = null;
        this._timer = null;
        this._showNext();
      }, CELEBRATION_EXIT_MS);
    },

    // ─── Lecture pour le gabarit (build CSP : pas d'expressions) ────────────
    get visible(): boolean {
      return this.current !== null;
    },
    get cardClass(): string {
      return this.leaving ? 'is-out' : 'is-in';
    },
    get title(): string {
      return this.current?.title ?? '';
    },
    get subtitle(): string {
      return this.current?.subtitle ?? '';
    },
    get badge(): string {
      return this.current?.badge ?? '';
    },
    get isRecord(): boolean {
      return this.current?.kind === 'record';
    },
    get isLevel(): boolean {
      return this.current?.kind === 'level';
    },
    get isRoutine(): boolean {
      return this.current?.kind === 'routine';
    },
  };
}
