/**
 * Tests de lib/avatar : texte de l'avatar (initiale locale, initiales du
 * compte, ou silhouette quand rien n'est connu).
 */
import { describe, expect, it } from 'vitest';
import { accountInitials, avatarText, firstInitial } from '../../apps/web/src/lib/avatar.js';

describe('firstInitial', () => {
  it('returns the uppercase first letter, accents included', () => {
    expect(firstInitial('élodie')).toBe('É');
    expect(firstInitial('  marc ')).toBe('M');
  });

  it('keeps a whole emoji (surrogate pair)', () => {
    expect(firstInitial('💪 Max')).toBe('💪');
  });

  it('returns an empty string for empty or missing names', () => {
    expect(firstInitial('')).toBe('');
    expect(firstInitial('   ')).toBe('');
    expect(firstInitial(null)).toBe('');
    expect(firstInitial(undefined)).toBe('');
  });
});

describe('accountInitials', () => {
  it('uses the full name, two letters max', () => {
    expect(accountInitials({ id: 'u', email: null, full_name: 'Alice Bob Charlie' })).toBe('AB');
  });

  it('falls back to the e-mail', () => {
    expect(accountInitials({ id: 'u', email: 'bob@test.com', full_name: null })).toBe('BT');
  });

  it('returns an empty string without user data', () => {
    expect(accountInitials(null)).toBe('');
    expect(accountInitials({ id: 'u', email: null, full_name: '  ' })).toBe('');
  });
});

describe('avatarText', () => {
  const alice = { id: 'u1', email: 'alice@x.fr', full_name: 'Alice Martin' };
  const guest = { id: 'guest', email: null, full_name: 'Invité' };

  it('prefers the local profile name initial', () => {
    expect(avatarText('Zoé', alice)).toBe('Z');
    expect(avatarText('Zoé', guest)).toBe('Z');
    expect(avatarText('Zoé', null)).toBe('Z');
  });

  it('uses the account initials when signed in without a local name', () => {
    expect(avatarText('', alice)).toBe('AM');
  });

  it('returns an empty string (person icon) for guests and signed-out users', () => {
    expect(avatarText('', guest)).toBe('');
    expect(avatarText(undefined, null)).toBe('');
  });
});
