import { describe, it, expect } from 'vitest';
import {
  effectiveTier,
  isPro,
  isOnTrial,
  canUse,
  activeProgramLimit,
  startTrial,
  PRO_FEATURES,
  FREE_ACTIVE_PROGRAM_LIMIT,
  type Entitlement,
} from '@kinetic/core';

const NOW = '2026-06-17T12:00:00.000Z';
const future = '2026-12-31T00:00:00.000Z';
const past = '2026-01-01T00:00:00.000Z';

describe('effectiveTier', () => {
  it('défaut = free (entitlement vide ou null)', () => {
    expect(effectiveTier(null, NOW)).toBe('free');
    expect(effectiveTier({}, NOW)).toBe('free');
  });

  it('Pro permanent quand tier=pro sans proUntil', () => {
    expect(effectiveTier({ tier: 'pro' }, NOW)).toBe('pro');
  });

  it('Pro tant que proUntil est dans le futur', () => {
    expect(effectiveTier({ tier: 'pro', proUntil: future }, NOW)).toBe('pro');
  });

  it('retombe en free quand proUntil est dépassé', () => {
    expect(effectiveTier({ tier: 'pro', proUntil: past }, NOW)).toBe('free');
  });

  it('essai actif donne un accès Pro effectif', () => {
    expect(effectiveTier({ trialEndsAt: future }, NOW)).toBe('pro');
  });

  it('essai expiré → free', () => {
    expect(effectiveTier({ trialEndsAt: past }, NOW)).toBe('free');
  });
});

describe('isPro / isOnTrial', () => {
  it('isPro reflète le tier effectif', () => {
    expect(isPro({ tier: 'pro' }, NOW)).toBe(true);
    expect(isPro({}, NOW)).toBe(false);
  });

  it('isOnTrial vrai uniquement quand le Pro vient du trial', () => {
    expect(isOnTrial({ trialEndsAt: future }, NOW)).toBe(true);
    // déjà Pro payant → pas "on trial" même si un trial traîne
    expect(isOnTrial({ tier: 'pro', proUntil: future, trialEndsAt: future }, NOW)).toBe(false);
    // free sans trial → non
    expect(isOnTrial({}, NOW)).toBe(false);
  });
});

describe('canUse', () => {
  it('bloque les features Pro pour un utilisateur gratuit', () => {
    for (const f of PRO_FEATURES) {
      expect(canUse({}, f, NOW)).toBe(false);
    }
  });

  it('autorise les features Pro pour un abonné', () => {
    for (const f of PRO_FEATURES) {
      expect(canUse({ tier: 'pro' }, f, NOW)).toBe(true);
    }
  });

  it('autorise pendant l essai', () => {
    expect(canUse({ trialEndsAt: future }, 'ai_coach', NOW)).toBe(true);
  });
});

describe('activeProgramLimit', () => {
  it('limite le gratuit, illimité en Pro', () => {
    expect(activeProgramLimit({}, NOW)).toBe(FREE_ACTIVE_PROGRAM_LIMIT);
    expect(activeProgramLimit({ tier: 'pro' }, NOW)).toBe(Infinity);
  });
});

describe('startTrial', () => {
  it('crée un essai de 7 jours à partir de maintenant', () => {
    const e: Entitlement = startTrial(NOW);
    expect(e.trialEndsAt).toBe('2026-06-24T12:00:00.000Z');
    expect(isPro(e, NOW)).toBe(true);
    expect(isPro(e, '2026-06-25T12:00:00.000Z')).toBe(false); // après expiration
  });
});
