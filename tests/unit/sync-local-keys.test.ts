/**
 * Clés propres à l'appareil : la liste du client de synchro (adapter-web, chargée au
 * démarrage) DOIT rester identique aux règles `device` du registre de fusion du core.
 */
import { describe, expect, it } from 'vitest';
import { SYNC_MERGE_RULES, isDeviceLocalKey } from '@kinetic/core';
import { LOCAL_ONLY_KEYS, isLocalOnlyKey } from '@kinetic/adapters-web';

describe('clés locales de la synchro', () => {
  it('chaque règle « device » du core est locale pour le client', () => {
    const device = SYNC_MERGE_RULES.filter((r) => r.scope === 'device');
    expect(device.length).toBeGreaterThan(0);
    for (const rule of device) {
      expect(rule.prefix).toBeUndefined(); // le client ne gère que des clés exactes
      expect(isLocalOnlyKey(rule.exact!)).toBe(true);
    }
  });

  it('chaque clé locale du client est « device » dans le core', () => {
    for (const key of LOCAL_ONLY_KEYS) expect(isDeviceLocalKey(key)).toBe(true);
  });

  it('une séance ou une préférence n est jamais locale', () => {
    expect(isLocalOnlyKey('kinetic:training:session:abc')).toBe(false);
    expect(isLocalOnlyKey('kinetic:xp')).toBe(false);
  });
});
