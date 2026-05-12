import { describe, it, expect } from 'vitest';
import { DEFAULT_EXERCISES, DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';

describe('DEFAULT_EXERCISES', () => {
  it('is non-empty', () => {
    expect(DEFAULT_EXERCISES.length).toBeGreaterThan(0);
  });

  it('every exercise has required fields', () => {
    for (const ex of DEFAULT_EXERCISES) {
      expect(typeof ex.id).toBe('string');
      expect(ex.id.length).toBeGreaterThan(0);
      expect(typeof ex.name).toBe('string');
      expect(ex.name.length).toBeGreaterThan(0);
      expect(Array.isArray(ex.muscles)).toBe(true);
      expect(typeof ex.equipment).toBe('string');
      expect(typeof ex.incrementKg).toBe('number');
      expect(ex.incrementKg).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = DEFAULT_EXERCISES.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('equipment values are from allowed set', () => {
    const allowed = new Set(['barbell', 'dumbbell', 'bodyweight', 'cable', 'machine', 'other']);
    for (const ex of DEFAULT_EXERCISES) {
      expect(allowed.has(ex.equipment)).toBe(true);
    }
  });

  it('contains expected key exercises', () => {
    const ids = new Set(DEFAULT_EXERCISES.map((e) => e.id));
    expect(ids.has('sq')).toBe(true);   // Back Squat
    expect(ids.has('bp')).toBe(true);   // Bench Press
    expect(ids.has('dl')).toBe(true);   // Deadlift
    expect(ids.has('ohp')).toBe(true);  // Overhead Press
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('is non-empty', () => {
    expect(DEFAULT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('every template has required fields', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      expect(typeof tpl.id).toBe('string');
      expect(typeof tpl.name).toBe('string');
      expect(typeof tpl.createdAt).toBe('string');
      expect(Array.isArray(tpl.exercises)).toBe(true);
      expect(tpl.exercises.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('template exercises reference valid exercise ids', () => {
    const validIds = new Set(DEFAULT_EXERCISES.map((e) => e.id));
    for (const tpl of DEFAULT_TEMPLATES) {
      for (const entry of tpl.exercises) {
        expect(validIds.has(entry.exerciseId)).toBe(true);
        expect(entry.sets).toBeGreaterThan(0);
        expect(entry.targetReps).toBeGreaterThan(0);
        expect(entry.targetRpe).toBeGreaterThanOrEqual(6);
        expect(entry.targetRpe).toBeLessThanOrEqual(10);
      }
    }
  });

  it('includes Push/Pull/Legs templates', () => {
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    expect(names.some((n) => n.toLowerCase().includes('push'))).toBe(true);
    expect(names.some((n) => n.toLowerCase().includes('pull'))).toBe(true);
    expect(names.some((n) => n.toLowerCase().includes('legs') || n.toLowerCase().includes('leg'))).toBe(true);
  });
});
