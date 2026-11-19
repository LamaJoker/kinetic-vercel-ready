import { describe, it, expect } from 'vitest';
import {
  parseCountText,
  formatLike,
  easeOutCubic,
  countFrame,
} from '../../apps/web/src/lib/count-up.js';

describe('chiffres qui défilent : lecture du format', () => {
  it('entier simple, décimale française, préfixe et suffixe', () => {
    expect(parseCountText('42')).toMatchObject({ value: 42, decimals: 0, prefix: '', suffix: '' });
    expect(parseCountText('72,5')).toMatchObject({ value: 72.5, decimals: 1, decimalSep: ',' });
    expect(parseCountText('~0,45 kg')).toMatchObject({
      prefix: '~',
      value: 0.45,
      decimals: 2,
      suffix: ' kg',
    });
  });

  it('milliers groupés (espace fine insécable, insécable, ordinaire)', () => {
    expect(parseCountText('12 345')).toMatchObject({ value: 12345, groupSep: ' ' });
    expect(parseCountText('1 234,5 kg')).toMatchObject({ value: 1234.5, groupSep: ' ' });
    expect(parseCountText('2 000')).toMatchObject({ value: 2000, groupSep: ' ' });
  });

  it('signes + et −', () => {
    expect(parseCountText('+1,2')).toMatchObject({ value: 1.2, sign: '+' });
    expect(parseCountText('−0,5')).toMatchObject({ value: -0.5, sign: '−' });
  });

  it('texte sans nombre : null', () => {
    expect(parseCountText('—')).toBeNull();
    expect(parseCountText('')).toBeNull();
  });
});

describe('chiffres qui défilent : réécriture au même format', () => {
  it('garde décimales, virgule, groupement et suffixe', () => {
    const fmt = parseCountText('12 345 kg')!;
    expect(formatLike(999.4, fmt)).toBe('999 kg');
    expect(formatLike(5432.6, fmt)).toBe('5 433 kg');
    const dec = parseCountText('72,5')!;
    expect(formatLike(0, dec)).toBe('0,0');
    expect(formatLike(36.27, dec)).toBe('36,3');
  });

  it('signe conservé (moins typographique par défaut)', () => {
    expect(formatLike(-3, parseCountText('−5')!)).toBe('−3');
    expect(formatLike(-3, parseCountText('-5')!)).toBe('-3');
    expect(formatLike(2, parseCountText('+5')!)).toBe('+2');
    expect(formatLike(-0.01, parseCountText('−0,5')!)).toBe('0,0');
  });

  it('ralenti doux : borné, 0 → 1, décélère', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('image d’animation : départ, milieu, arrivée', () => {
    const to = parseCountText('1 000 XP')!;
    expect(countFrame(0, to, 0)).toBe('0 XP');
    expect(countFrame(0, to, 1)).toBe('1 000 XP');
    expect(countFrame(0, to, 0.5)).toBe('875 XP');
    // depuis l'ancienne valeur
    expect(countFrame(800, to, 0)).toBe('800 XP');
  });
});

describe('chiffres qui défilent : branchement', () => {
  it('élément caché : la vraie valeur 0 remplace la valeur en attente', async () => {
    const { vi } = await import('vitest');
    const { bindCountUp } = await import('../../apps/web/src/lib/count-up.js');
    // Faux observateurs : la mutation est livrée à la demande (comme une micro-tâche).
    let ioCb: ((e: { isIntersecting: boolean }[]) => void) | null = null;
    const queue: unknown[] = [];
    let moCb: (() => void) | null = null;
    class FakeMO {
      constructor(cb: () => void) {
        moCb = cb;
      }
      observe(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return queue.splice(0);
      }
    }
    class FakeIO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        ioCb = cb;
      }
      observe(): void {}
      disconnect(): void {}
    }
    let frames: ((t: number) => void)[] = [];
    vi.stubGlobal('MutationObserver', FakeMO);
    vi.stubGlobal('IntersectionObserver', FakeIO);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => frames.push(f));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      let text = '';
      const el = {
        get textContent() {
          return text;
        },
        set textContent(v: string) {
          text = v;
          queue.push(v);
        },
      };
      // x-text écrit la valeur (élément pas encore visible).
      const xText = (v: string): void => {
        el.textContent = v;
        if (queue.length) {
          queue.length = 0;
          moCb?.();
        }
      };
      bindCountUp(el as unknown as HTMLElement);
      xText('7');
      expect(text).toBe('0'); // point de départ affiché
      xText('0'); // vraie valeur : 0
      ioCb!([{ isIntersecting: true }]);
      // Aucune animation vers l'ancienne valeur 7.
      for (let i = 0; i < 5 && frames.length; i++) {
        const f = frames;
        frames = [];
        f.forEach((cb) => cb(performance.now() + 10_000));
      }
      expect(text).toBe('0');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
