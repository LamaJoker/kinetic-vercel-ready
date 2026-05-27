import { describe, it, expect } from 'vitest';
import {
  parseTempo,
  tempoPreset,
  repDurationSec,
  timeUnderTensionSec,
  suggestEmomReps,
  computeEmomVolume,
} from '../../packages/core/src/domain/tempo.domain.js';

describe('parseTempo', () => {
  it('parse "4-1-2-0"', () => {
    const t = parseTempo('4-1-2-0');
    expect(t).toEqual({ eccentricSec: 4, pauseBottomSec: 1, concentricSec: 2, pauseTopSec: 0 });
  });

  it('parse "4120" (sans tirets)', () => {
    expect(parseTempo('4120')).toEqual({
      eccentricSec: 4,
      pauseBottomSec: 1,
      concentricSec: 2,
      pauseTopSec: 0,
    });
  });

  it("traite 'X' comme 0.5 s (explosive)", () => {
    const t = parseTempo('3-0-X-0');
    expect(t!.concentricSec).toBe(0.5);
  });

  it('refuse les inputs invalides', () => {
    expect(parseTempo('garbage')).toBeNull();
    expect(parseTempo('1-2-3')).toBeNull();
    expect(parseTempo('99-1-1-1')).toBeNull(); // > 15 s exclu
  });
});

describe('tempoPreset', () => {
  it("retourne 'standard' par défaut", () => {
    expect(tempoPreset('standard').eccentricSec).toBe(2);
  });

  it("'control' a une excentrique longue", () => {
    const p = tempoPreset('control');
    expect(p.eccentricSec).toBeGreaterThanOrEqual(p.concentricSec);
  });
});

describe('repDurationSec / timeUnderTensionSec', () => {
  it('somme les 4 phases', () => {
    expect(
      repDurationSec({ eccentricSec: 2, pauseBottomSec: 1, concentricSec: 1, pauseTopSec: 0 }),
    ).toBe(4);
  });

  it('TUT = rep duration × reps', () => {
    expect(
      timeUnderTensionSec(
        { eccentricSec: 3, pauseBottomSec: 0, concentricSec: 1, pauseTopSec: 1 },
        10,
      ),
    ).toBe(50);
  });
});

describe('suggestEmomReps', () => {
  it("baisse les reps quand l'intensité monte", () => {
    expect(suggestEmomReps(0.5)).toBeGreaterThan(suggestEmomReps(0.7));
    expect(suggestEmomReps(0.7)).toBeGreaterThan(suggestEmomReps(0.9));
  });

  it('clamp aux extrêmes', () => {
    expect(suggestEmomReps(0.1)).toBeGreaterThan(0);
    expect(suggestEmomReps(0.99)).toBeGreaterThan(0);
  });
});

describe('computeEmomVolume', () => {
  it('reps totales = reps × minutes', () => {
    const r = computeEmomVolume({ repsPerMinute: 5, totalMinutes: 10, weightKg: 60 });
    expect(r.totalReps).toBe(50);
    expect(r.tonnageKg).toBe(3000);
  });
});
