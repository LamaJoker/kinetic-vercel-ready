import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/web/src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../apps/web/src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: vi.fn() } }));

const { dashboard } = await import('../../apps/web/src/pages/dashboard.page.js');
const { navigate } = await import('../../apps/web/src/router');

describe('accueil — séance en cours', () => {
  it('le bouton reprend la séance en cours au lieu d’en démarrer une', () => {
    const page = dashboard();
    expect(page.startLabel()).toBe('Commencer la séance');
    page.hasActiveSession = true;
    expect(page.startLabel()).toBe('Reprendre la séance');
  });

  it('avec une séance en cours, ouvre Séances sans programmer de nouveau modèle', () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem, getItem: vi.fn(), removeItem: vi.fn() });
    const page = dashboard();
    page.training = { next: { templateId: 't1' } } as unknown as typeof page.training;
    page.hasActiveSession = true;
    page.startNextSession();
    expect(setItem).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/seances');
    vi.unstubAllGlobals();
  });
});
