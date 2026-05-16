/**
 * tests/unit/crdt.test.ts
 *
 * Tests du moteur CRDT Vector Clock (apps/web/src/lib/sync.ts).
 * Couvre : increment, merge, compare, resolveConflict.
 */

import { describe, it, expect } from 'vitest';
// M5 FIX: importer les vraies fonctions depuis le module de production
import {
  createClock,
  incrementClock,
  mergeClock,
  compareClocks,
  resolveConflict,
} from '../../apps/web/src/lib/sync.js';
import type { VectorClock, SyncedValue, CausalOrder } from '../../apps/web/src/lib/sync.js';

describe('CRDT Vector Clock', () => {
  describe('createClock', () => {
    it('crée une horloge avec count 0 pour le device', () => {
      const clock = createClock('device-A');
      expect(clock['device-A']).toBe(0);
    });
  });

  describe('incrementClock', () => {
    it('incrémente le compteur du device', () => {
      const c1 = createClock('A');
      const c2 = incrementClock(c1, 'A');
      expect(c2['A']).toBe(1);
    });

    it('ne modifie pas les autres devices', () => {
      const c1: VectorClock = { A: 3, B: 5 };
      const c2 = incrementClock(c1, 'A');
      expect(c2['B']).toBe(5);
    });

    it("est immutable (ne mute pas l'original)", () => {
      const c1 = createClock('A');
      incrementClock(c1, 'A');
      expect(c1['A']).toBe(0);
    });
  });

  describe('mergeClock', () => {
    it('prend le max de chaque device', () => {
      const a: VectorClock = { A: 3, B: 1 };
      const b: VectorClock = { A: 1, B: 4 };
      const merged = mergeClock(a, b);
      expect(merged['A']).toBe(3);
      expect(merged['B']).toBe(4);
    });

    it("inclut les devices absents de l'un ou l'autre", () => {
      const a: VectorClock = { A: 2 };
      const b: VectorClock = { B: 5 };
      const merged = mergeClock(a, b);
      expect(merged['A']).toBe(2);
      expect(merged['B']).toBe(5);
    });
  });

  describe('compareClocks', () => {
    it('retourne "equal" pour deux horloges identiques', () => {
      const c: VectorClock = { A: 2, B: 3 };
      expect(compareClocks(c, { ...c })).toBe('equal');
    });

    it('retourne "before" quand a est causalement avant b', () => {
      const a: VectorClock = { A: 1, B: 1 };
      const b: VectorClock = { A: 2, B: 2 };
      expect(compareClocks(a, b)).toBe('before');
    });

    it('retourne "after" quand a est causalement après b', () => {
      const a: VectorClock = { A: 3, B: 3 };
      const b: VectorClock = { A: 1, B: 2 };
      expect(compareClocks(a, b)).toBe('after');
    });

    it('retourne "concurrent" pour des horloges incomparables', () => {
      const a: VectorClock = { A: 3, B: 1 };
      const b: VectorClock = { A: 1, B: 3 };
      expect(compareClocks(a, b)).toBe('concurrent');
    });
  });

  describe('resolveConflict', () => {
    const makeValue = <T>(
      value: T,
      clock: VectorClock,
      deviceId: string,
      wallTime: number,
    ): SyncedValue<T> => ({ value, clock, deviceId, wallTime });

    it('retourne le local si local est causalement après', () => {
      const local = makeValue('local', { A: 3 }, 'A', 1000);
      const remote = makeValue('remote', { A: 1 }, 'B', 2000);
      expect(resolveConflict(local, remote).value).toBe('local');
    });

    it('retourne le remote si remote est causalement après', () => {
      const local = makeValue('local', { A: 1 }, 'A', 1000);
      const remote = makeValue('remote', { A: 3 }, 'B', 500);
      expect(resolveConflict(local, remote).value).toBe('remote');
    });

    it('tiebreak par wallTime en cas de concurrence', () => {
      const clocks = { A: 2, B: 2 };
      const local = makeValue('local', { A: 3, B: 1 }, 'A', 1000);
      const remote = makeValue('remote', { A: 1, B: 3 }, 'B', 2000);
      // concurrent, remote a un wallTime plus récent → remote gagne
      expect(resolveConflict(local, remote).value).toBe('remote');
    });

    it('tiebreak par deviceId si même wallTime (déterministe)', () => {
      const sameTime = 1000;
      const local = makeValue('local', { A: 1, B: 0 }, 'device-Z', sameTime);
      const remote = makeValue('remote', { A: 0, B: 1 }, 'device-A', sameTime);
      // device-Z > device-A lexicographiquement → local gagne
      expect(resolveConflict(local, remote).value).toBe('local');
    });
  });
});
