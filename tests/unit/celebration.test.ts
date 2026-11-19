import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../apps/web/src/lib/haptics.js', () => ({
  hapticCelebrate: vi.fn(),
}));

import { STORAGE_KEYS } from '@kinetic/core';
import { hapticCelebrate } from '../../apps/web/src/lib/haptics.js';
import {
  recordCelebration,
  levelCelebration,
  routineCelebration,
  enqueueCelebration,
  asCelebration,
  celebrate,
  setCelebrationsMuted,
  celebrationsMuted,
  celebration,
  CELEBRATION_MS,
  CELEBRATION_REWARD_MS,
  CELEBRATION_EXIT_MS,
  MAX_QUEUE,
  PARTICLE_COUNT,
  type CelebrationDetail,
} from '../../apps/web/src/lib/celebration.js';

const rec = (name: string): CelebrationDetail => recordCelebration(name, 100, 5);

describe('textes des célébrations', () => {
  it('record : exercice, charge à la française et répétitions', () => {
    expect(recordCelebration('Squat', 120, 5)).toEqual({
      kind: 'record',
      title: 'Nouveau record !',
      subtitle: 'Squat 120\u00a0kg\u00a0×\u00a05',
    });
    expect(recordCelebration('Développé couché', 97.5, 3).subtitle).toBe(
      'Développé couché 97,5\u00a0kg\u00a0×\u00a03',
    );
  });

  it('record au poids du corps : pas de « 0 kg »', () => {
    expect(recordCelebration('Tractions', 0, 12).subtitle).toBe('Tractions ×\u00a012');
    expect(recordCelebration('  ', 50, 2).subtitle).toBe('50\u00a0kg\u00a0×\u00a02');
  });

  it('niveau : titre, médaille et récompense éventuelle', () => {
    expect(levelCelebration(6)).toEqual({
      kind: 'level',
      title: 'Niveau 6 atteint',
      subtitle: 'Continue sur ta lancée',
      badge: '6',
    });
    expect(levelCelebration(10, 'Thème Cyber').subtitle).toBe(
      'Récompense débloquée\u00a0: Thème Cyber',
    );
  });

  it('routine : 100 %', () => {
    expect(routineCelebration(5)).toEqual({
      kind: 'routine',
      title: 'Routine du jour complète',
      subtitle: '5 sur 5 · 100\u00a0%',
    });
  });
});

describe('enqueueCelebration (une seule à la fois, file courte)', () => {
  it('ajoute à la suite', () => {
    const q = enqueueCelebration([], null, rec('A'));
    expect(enqueueCelebration(q, null, rec('B'))).toHaveLength(2);
  });

  it('ignore un doublon de la carte affichée ou de la dernière en attente', () => {
    expect(enqueueCelebration([], rec('A'), rec('A'))).toHaveLength(0);
    expect(enqueueCelebration([rec('B')], rec('A'), rec('B'))).toHaveLength(1);
    expect(enqueueCelebration([rec('B')], rec('A'), rec('A'))).toHaveLength(2);
  });

  it(`plafonne la file à ${MAX_QUEUE}`, () => {
    let q: CelebrationDetail[] = [];
    for (let i = 0; i < MAX_QUEUE + 3; i++) q = enqueueCelebration(q, rec('X'), rec(`E${i}`));
    expect(q).toHaveLength(MAX_QUEUE);
  });

  it('ne modifie pas la file reçue', () => {
    const q: CelebrationDetail[] = [];
    enqueueCelebration(q, null, rec('A'));
    expect(q).toHaveLength(0);
  });
});

describe('asCelebration (detail venu de window)', () => {
  it('rejette les formes invalides', () => {
    expect(asCelebration(null)).toBeNull();
    expect(asCelebration('x')).toBeNull();
    expect(asCelebration({ kind: 'autre', title: 'a' })).toBeNull();
    expect(asCelebration({ kind: 'record', title: '' })).toBeNull();
  });

  it('garde seulement les champs connus', () => {
    expect(asCelebration({ kind: 'level', title: 'T', badge: '3', subtitle: 1, extra: 2 })).toEqual(
      { kind: 'level', title: 'T', badge: '3' },
    );
  });
});

// ─── Navigateur minimal (environnement node) ────────────────────────────────

class FakeEl {
  children: FakeEl[] = [];
  style = {
    props: {} as Record<string, string>,
    setProperty(k: string, v: string) {
      this.props[k] = v;
    },
  };
  get childElementCount(): number {
    return this.children.length;
  }
  appendChild(c: FakeEl): void {
    this.children.push(c);
  }
}

let target: EventTarget;

beforeEach(() => {
  target = new EventTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { createElement: () => new FakeEl() });
  vi.mocked(hapticCelebrate).mockClear();
  setCelebrationsMuted(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('celebrate()', () => {
  it('émet EVENT_CELEBRATE avec le detail', () => {
    const seen: unknown[] = [];
    target.addEventListener(STORAGE_KEYS.EVENT_CELEBRATE, (e) =>
      seen.push((e as CustomEvent).detail),
    );
    celebrate(rec('Squat'));
    expect(seen).toEqual([rec('Squat')]);
  });

  it('ne fait rien quand c’est coupé (chargement de la démo)', () => {
    const fn = vi.fn();
    target.addEventListener(STORAGE_KEYS.EVENT_CELEBRATE, fn);
    setCelebrationsMuted(true);
    expect(celebrationsMuted()).toBe(true);
    celebrate(rec('Squat'));
    expect(fn).not.toHaveBeenCalled();
  });
});

function mount() {
  const burst = new FakeEl();
  const c = celebration() as ReturnType<typeof celebration> & { $el: unknown };
  c.$el = { querySelector: () => burst };
  c.init();
  return { c, burst };
}

const tap = () => target.dispatchEvent(new Event('pointerdown'));

describe('composant celebration', () => {
  it(`génère ${PARTICLE_COUNT} éclats orientés`, () => {
    const { burst } = mount();
    expect(burst.children).toHaveLength(PARTICLE_COUNT);
    expect(burst.children[0]!.style.props['--k-cel-a']).toMatch(/deg$/);
  });

  it('ignore tout avant le premier toucher (rien au lancement)', () => {
    const { c } = mount();
    celebrate(rec('Squat'));
    target.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP, { detail: { level: 4, title: '' } }),
    );
    expect(c.visible).toBe(false);
    expect(hapticCelebrate).not.toHaveBeenCalled();
  });

  it('affiche, vibre une fois, puis passe à la suivante après le délai', () => {
    vi.useFakeTimers();
    const { c } = mount();
    tap();
    celebrate(rec('Squat'));
    target.dispatchEvent(
      new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP, { detail: { level: 6, title: 'Thème' } }),
    );
    expect(c.visible).toBe(true);
    expect(c.isRecord).toBe(true);
    expect(c.title).toBe('Nouveau record !');
    expect(c.subtitle).toBe('Squat 100\u00a0kg\u00a0×\u00a05');
    expect(c.cardClass).toBe('is-in');
    expect(hapticCelebrate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(CELEBRATION_MS);
    expect(c.cardClass).toBe('is-out');
    vi.advanceTimersByTime(CELEBRATION_EXIT_MS);
    expect(c.isLevel).toBe(true);
    expect(c.badge).toBe('6');
    expect(c.title).toBe('Niveau 6 atteint');
    expect(hapticCelebrate).toHaveBeenCalledTimes(2);
    // Niveau 6 = récompense « Gel de série » intégrée : la carte reste plus longtemps.
    expect(c.hasReward).toBe(true);
    vi.advanceTimersByTime(CELEBRATION_MS);
    expect(c.visible).toBe(true);

    vi.advanceTimersByTime(CELEBRATION_REWARD_MS - CELEBRATION_MS + CELEBRATION_EXIT_MS);
    expect(c.visible).toBe(false);
    expect(hapticCelebrate).toHaveBeenCalledTimes(2);
  });

  it('toucher la carte la ferme tout de suite (une seule sortie)', () => {
    vi.useFakeTimers();
    const { c } = mount();
    tap();
    celebrate(routineCelebration(4));
    expect(c.isRoutine).toBe(true);
    c.dismiss();
    c.dismiss();
    expect(c.cardClass).toBe('is-out');
    vi.advanceTimersByTime(CELEBRATION_EXIT_MS);
    expect(c.visible).toBe(false);
  });

  it('ignore un niveau invalide et les détails malformés', () => {
    const { c } = mount();
    tap();
    target.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_LEVELUP));
    target.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_CELEBRATE, { detail: { kind: 'x' } }));
    expect(c.visible).toBe(false);
  });

  it('destroy retire les écouteurs', () => {
    const { c } = mount();
    tap();
    c.destroy();
    celebrate(rec('Squat'));
    expect(c.visible).toBe(false);
  });
});
