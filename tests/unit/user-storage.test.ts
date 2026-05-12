import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '../helpers/stubs.js';
import {
  loadUserProfile,
  saveUserProfile,
  clearUserProfile,
} from '../../apps/web/src/lib/user/storage.js';
import type { UserProfile } from '../../apps/web/src/lib/user/types.js';

const validProfile: UserProfile = {
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sex: 'male',
  ageYears: 30,
  heightCm: 175,
  weightKg: 75,
  activity: 'active',
  goal: 'gain_muscle',
};

describe('loadUserProfile', () => {
  it('returns null when no profile stored', async () => {
    const storage = new InMemoryStorage();
    expect(await loadUserProfile(storage)).toBeNull();
  });

  it('returns the stored profile when version=1', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:userProfile', validProfile);
    const result = await loadUserProfile(storage);
    expect(result).toEqual(validProfile);
  });

  it('returns null when version is not 1', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:userProfile', { ...validProfile, version: 2 });
    expect(await loadUserProfile(storage)).toBeNull();
  });

  it('returns null when stored value is not an object', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:userProfile', 'invalid-string');
    expect(await loadUserProfile(storage)).toBeNull();
  });

  it('returns null for null stored value', async () => {
    const storage = new InMemoryStorage();
    await storage.set('kinetic:userProfile', null);
    expect(await loadUserProfile(storage)).toBeNull();
  });
});

describe('saveUserProfile', () => {
  it('persists the profile', async () => {
    const storage = new InMemoryStorage();
    await saveUserProfile(storage, validProfile);
    const stored = await storage.get('kinetic:userProfile');
    expect(stored).toEqual(validProfile);
  });

  it('overwrites a previously stored profile', async () => {
    const storage = new InMemoryStorage();
    await saveUserProfile(storage, validProfile);
    const updated = { ...validProfile, weightKg: 80 };
    await saveUserProfile(storage, updated);
    expect(await loadUserProfile(storage)).toEqual(updated);
  });
});

describe('clearUserProfile', () => {
  it('removes the profile from storage', async () => {
    const storage = new InMemoryStorage();
    await saveUserProfile(storage, validProfile);
    await clearUserProfile(storage);
    expect(await loadUserProfile(storage)).toBeNull();
  });

  it('is idempotent when no profile stored', async () => {
    const storage = new InMemoryStorage();
    await expect(clearUserProfile(storage)).resolves.toBeUndefined();
  });
});
