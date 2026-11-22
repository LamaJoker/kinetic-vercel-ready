/**
 * Carte du jour de l'accueil : avec une séance en cours, elle en affiche le nom
 * (et non la séance proposée).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../apps/web/src/router', () => ({ navigate: vi.fn() }));
vi.mock('../../apps/web/src/lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('alpinejs', () => ({ default: { store: vi.fn() } }));

const { dashboard } = await import('../../apps/web/src/pages/dashboard.page.js');

function pageWithNext() {
  const page = dashboard();
  page.training = {
    totalSessions: 12,
    daysSinceLast: 1,
    next: {
      templateId: 'pull-a',
      name: 'Pull A',
      exerciseCount: 5,
      setCount: 16,
      reason: 'rotation',
    },
  } as unknown as typeof page.training;
  return page;
}

describe('accueil — carte du jour', () => {
  it('sans séance en cours : la séance proposée', () => {
    const page = pageWithNext();
    expect(page.todayTitle).toBe('Pull A');
    expect(page.todayKicker).toBe('Séance du jour');
    expect(page.nextDetail).toBe('5 exercices, 16 séries');
  });

  it('séance en cours : son nom, « Séance en cours », « Reprendre la séance »', () => {
    const page = pageWithNext();
    page.hasActiveSession = true;
    page.activeSessionName = 'Push A';
    expect(page.todayTitle).toBe('Push A');
    expect(page.todayKicker).toBe('Séance en cours');
    expect(page.startLabel()).toBe('Reprendre la séance');
    expect(page.nextDetail).toBe('');
  });

  it('séance en cours sans nom : retombe sur la séance proposée', () => {
    const page = pageWithNext();
    page.hasActiveSession = true;
    expect(page.todayTitle).toBe('Pull A');
  });

  it('première séance, ou déjà entraîné aujourd’hui', () => {
    const page = pageWithNext();
    (page.training as { totalSessions: number }).totalSessions = 0;
    expect(page.todayKicker).toBe('Ta première séance');
    (page.training as { totalSessions: number; daysSinceLast: number }).totalSessions = 3;
    (page.training as { daysSinceLast: number }).daysSinceLast = 0;
    expect(page.todayKicker).toBe('Déjà entraîné aujourd’hui — prochaine séance');
  });
});
