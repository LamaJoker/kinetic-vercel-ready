import { describe, it, expect, vi } from 'vitest';

// La page importe Alpine, qui a besoin du DOM : seul le helper pur est testé ici.
vi.mock('alpinejs', () => ({ default: { store: () => undefined } }));
import { levelRingStyle, rewardBadgeClass } from '../../apps/web/src/pages/profile.page.js';
import { goalCardClass } from '../../apps/web/src/pages/onboarding.page.js';

describe('profil — présentation', () => {
  it("levelRingStyle borne la progression de l'anneau entre 0 et 100", () => {
    expect(levelRingStyle(42)).toBe('--p: 42');
    expect(levelRingStyle(42.6)).toBe('--p: 43');
    expect(levelRingStyle(140)).toBe('--p: 100');
    expect(levelRingStyle(-5)).toBe('--p: 0');
    expect(levelRingStyle(undefined)).toBe('--p: 0');
    expect(levelRingStyle(Number.NaN)).toBe('--p: 0');
  });

  it("rewardBadgeClass teinte la pastille par l'accent seulement si débloquée", () => {
    expect(rewardBadgeClass(true)).toContain('text-kinetic-neon');
    expect(rewardBadgeClass(false)).toBe('bg-kinetic-elevated text-gray-500');
  });
});

describe('onboarding — présentation', () => {
  it("goalCardClass met un liseré d'accent sur la carte choisie", () => {
    expect(goalCardClass(true)).toBe('ring-2 ring-kinetic-neon');
    expect(goalCardClass(false)).toBe('');
  });
});

describe('profil — tirer pour rafraîchir', () => {
  it('refresh() relit la page sans écraser un prénom en cours de saisie', async () => {
    const { profile } = await import('../../apps/web/src/pages/profile.page.js');
    const page = profile();
    page.displayName = 'Léa';
    page.displayNameInput = 'Lé';
    page.init = vi.fn(async () => {
      page.displayNameInput = page.displayName;
    });
    await page.refresh();
    expect(page.init).toHaveBeenCalledTimes(1);
    expect(page.displayNameInput).toBe('Lé');
  });

  it('refresh() reprend le nom enregistré quand rien n’est en cours de saisie', async () => {
    const { profile } = await import('../../apps/web/src/pages/profile.page.js');
    const page = profile();
    page.displayName = 'Léa';
    page.displayNameInput = 'Léa';
    page.init = vi.fn(async () => {
      page.displayName = 'Lou';
      page.displayNameInput = 'Lou';
    });
    await page.refresh();
    expect(page.displayNameInput).toBe('Lou');
  });
});
