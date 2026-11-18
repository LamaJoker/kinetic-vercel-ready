/** Éditeur de modèles : lier / délier en superset, mesure d'un exercice perso. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/web/src/router.js', () => ({ navigate: vi.fn() }));

import { templateEditor } from '../../apps/web/src/pages/template-editor.page.js';

const line = (exerciseId: string) => ({ exerciseId, sets: 3, targetReps: 8, targetRpe: 8 });

describe('éditeur de modèles : supersets', () => {
  it('lier, étiquettes, déplacer, délier', () => {
    const t = templateEditor();
    t.lines = [line('bench'), line('row'), line('curl')];
    expect(t.canLink(0)).toBe(true);
    t.linkNext(0);
    expect([t.lineTag(0), t.lineTag(1), t.lineTag(2)]).toEqual(['A1', 'A2', '']);
    expect(t.linkedWithNext(0)).toBe(true);
    expect(t.linkedWithNext(1)).toBe(false);
    expect(t.lineCardClass(0)).toContain('ring-kinetic-purple');
    // Descendre A2 sous « curl » : le superset n'est plus consécutif, il disparaît
    t.moveDown(1);
    expect(t.lines.map((l) => l.group)).toEqual([undefined, undefined, undefined]);
    t.linkNext(0);
    t.linkNext(1);
    expect(t.lineTag(2)).toBe('A3');
    t.unlinkAt(2);
    expect(t.lines.every((l) => l.group === undefined)).toBe(true);
  });

  it('retirer une ligne dissout le superset isolé', () => {
    const t = templateEditor();
    t.lines = [line('bench'), line('row')];
    t.linkNext(0);
    t.removeLine(1);
    expect(t.lines[0]!.group).toBeUndefined();
  });
});

describe('nouvel exercice : mesure', () => {
  it('proposée d’après le nom, modifiable', () => {
    const t = templateEditor();
    t.view = 'template';
    t.query = 'Gainage lesté';
    t.newExercise();
    expect(t.form.measure).toBe('time');
    t.setMeasure('distance');
    expect(t.isMeasure('distance')).toBe(true);
    expect(
      t.customMeta({
        id: 'x',
        name: 'Luge',
        muscles: [],
        equipment: 'other',
        incrementKg: 2.5,
        measure: 'distance',
      }),
    ).toContain('Distance');
  });
});
