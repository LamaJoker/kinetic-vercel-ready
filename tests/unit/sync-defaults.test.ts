/**
 * Valeurs par défaut jamais persistées avant la synchro, et échec de lecture ≠ absence
 * (audit qualité F3, docs/architecture/sync.md § 4.6).
 */
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../../apps/web/src/lib/training/storage.js';
import { DEFAULT_TEMPLATES } from '../../apps/web/src/lib/training/seed.js';
import { createDevice, FakeSyncServer } from '../support/sync-harness';

describe('loadTemplates', () => {
  it('clé absente : modèles par défaut en mémoire, rien n est écrit ni mis en file', async () => {
    const server = new FakeSyncServer();
    const s = await createDevice(server).open('user-a');
    const tpl = await loadTemplates(s);
    expect(tpl.length).toBe(DEFAULT_TEMPLATES.length);
    expect(await s.get('kinetic:training:templates')).toBeNull();
    expect(await s.pendingCount()).toBe(0);
  });

  it('échec de lecture IndexedDB : erreur propagée, les modèles de l utilisateur ne sont pas écrasés', async () => {
    const server = new FakeSyncServer();
    const dev = createDevice(server);
    const s = await dev.open('user-a');
    const mine = [
      { id: 'mine', name: 'Mon modèle', createdAt: '2026-01-01T00:00:00.000Z', exercises: [] },
    ];
    await s.set('kinetic:training:templates', mine);
    await s.flushPendingWrites();
    dev.fake.failNext((op) => op.kind === 'get' && op.store === 'kv', 'UnknownError', 2);
    await expect(loadTemplates(s)).rejects.toThrow();
    expect(await s.get('kinetic:training:templates')).toEqual(mine);
    expect(server.live('user-a')['kinetic:training:templates']).toEqual(mine);
  });

  it('liste vide (tous les modèles supprimés) : respectée, pas de réapparition', async () => {
    const server = new FakeSyncServer();
    const s = await createDevice(server).open('user-a');
    await s.set('kinetic:training:templates', []);
    expect(await loadTemplates(s)).toEqual([]);
  });
});
