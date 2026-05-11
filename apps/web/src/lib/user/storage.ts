import type { StoragePort } from '@kinetic/core';
import { STORAGE_KEYS } from '@kinetic/core';
import type { UserProfile } from './types';

const KEY_PROFILE = STORAGE_KEYS.USER_PROFILE;

export async function loadUserProfile(storage: StoragePort): Promise<UserProfile | null> {
  const data = await storage.get<UserProfile>(KEY_PROFILE);
  if (!data || typeof data !== 'object') return null;
  if (data.version !== 1) return null;
  return data;
}

export async function saveUserProfile(storage: StoragePort, profile: UserProfile): Promise<void> {
  await storage.set(KEY_PROFILE, profile);
}

export async function clearUserProfile(storage: StoragePort): Promise<void> {
  await storage.remove(KEY_PROFILE);
}

