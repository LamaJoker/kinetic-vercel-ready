/**
 * QA-10 : à chaque navigation, le destroy() des composants de la page quittée doit
 * s'exécuter UNE fois. Avant, le routeur l'appelait à la main (champ interne
 * `_x_dataStack`), puis Alpine le rappelait en voyant les nœuds retirés.
 *
 * Test avec le VRAI `Alpine.destroyTree` : un composant x-data enregistre son destroy()
 * comme nettoyage de l'élément (`el._x_cleanups`), exactement comme Alpine.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { destroyPageComponents } from '../../apps/web/src/lib/page-teardown';

// Alpine touche au DOM dès son import : fenêtre et observateur inertes en Node.
vi.stubGlobal('window', { Element: class {} });
vi.stubGlobal('document', { createElement: () => ({}) });
vi.stubGlobal(
  'MutationObserver',
  class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  },
);
const { default: Alpine } = await import('alpinejs');

interface FakeEl {
  firstElementChild: FakeEl | null;
  nextElementSibling: FakeEl | null;
  _x_cleanups?: Array<() => void>;
}

function el(children: FakeEl[] = [], cleanups?: Array<() => void>): FakeEl {
  children.forEach((c, i) => (c.nextElementSibling = children[i + 1] ?? null));
  return {
    firstElementChild: children[0] ?? null,
    nextElementSibling: null,
    ...(cleanups ? { _x_cleanups: cleanups } : {}),
  };
}

describe('destroyPageComponents (QA-10)', () => {
  it('destroy() appelé une seule fois, même quand Alpine nettoie ensuite les nœuds retirés', () => {
    const destroyPage = vi.fn();
    const destroyNested = vi.fn();
    const host = el([el([el([], [destroyNested])], [destroyPage])]);

    destroyPageComponents(host as unknown as HTMLElement, Alpine);
    expect(destroyPage).toHaveBeenCalledTimes(1);
    expect(destroyNested).toHaveBeenCalledTimes(1);

    // `host.innerHTML = …` → l'observateur de mutations d'Alpine rappelle destroyTree.
    Alpine.destroyTree(host as unknown as HTMLElement);
    expect(destroyPage).toHaveBeenCalledTimes(1);
    expect(destroyNested).toHaveBeenCalledTimes(1);
  });

  it("une erreur dans un destroy() n'interrompt pas la navigation", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = el([
      el(
        [],
        [
          () => {
            throw new Error('boom');
          },
        ],
      ),
    ]);
    expect(() => destroyPageComponents(host as unknown as HTMLElement, Alpine)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("le routeur passe par l'API publique, plus par le champ interne _x_dataStack", () => {
    const src = readFileSync(resolve(__dirname, '../../apps/web/src/router.ts'), 'utf8');
    expect(src).not.toContain('_x_dataStack');
    expect(src).not.toContain('eslint-disable');
    expect(src).toContain('destroyPageComponents(host, Alpine)');
  });
});
