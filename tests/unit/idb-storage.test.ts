/**
 * IdbStorage — régression DataCloneError sur les Proxy réactifs Alpine.
 *
 * Alpine s'appuie sur @vue/reactivity : `this.x` dans un composant renvoie un
 * Proxy. IndexedDB (structured clone) refuse les Proxy → le 1er essai Pro et
 * les statuts de programme n'étaient jamais persistés en production.
 */
import { describe, it, expect } from 'vitest';
import { reactive, isProxy } from '@vue/reactivity';
import { IdbStorage } from '@kinetic/adapters-web';

describe('IdbStorage — valeurs réactives', () => {
  it('stocke une copie plate (jamais le Proxy) d un objet réactif', async () => {
    const storage = new IdbStorage('test-db', 'test-store');
    const state = reactive({ todo: { bench: true }, days: [1, 3] });
    expect(isProxy(state.todo)).toBe(true);

    await storage.set('kinetic:program:todoStatus:2026-09-15', state.todo);
    await storage.set('kinetic:program:completedDays:2026-W38', state.days);

    const todo = await storage.get('kinetic:program:todoStatus:2026-09-15');
    const days = await storage.get('kinetic:program:completedDays:2026-W38');
    expect(isProxy(todo)).toBe(false);
    expect(isProxy(days)).toBe(false);
    expect(() => structuredClone(todo)).not.toThrow();
    expect(todo).toEqual({ bench: true });
    expect(days).toEqual([1, 3]);
  });

  it('une mutation ultérieure de l objet source ne modifie pas la valeur stockée', async () => {
    const storage = new IdbStorage('test-db-2', 'test-store');
    const source = { tier: 'free' };
    await storage.set('kinetic:entitlement', source);
    source.tier = 'pro';
    expect(await storage.get('kinetic:entitlement')).toEqual({ tier: 'free' });
  });

  it('laisse passer les primitives', async () => {
    const storage = new IdbStorage('test-db-3', 'test-store');
    await storage.set('kinetic:program:generatedCount', 3);
    expect(await storage.get('kinetic:program:generatedCount')).toBe(3);
  });
});
