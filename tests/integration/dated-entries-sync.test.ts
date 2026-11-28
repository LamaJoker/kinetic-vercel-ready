/**
 * Saisies datées (pesées, mensurations, séance passée) sur DEUX appareils réels
 * (IndexedDB en mémoire + faux serveur de synchro + registre métier du core) :
 * une saisie dans le passé ne remplace jamais les jours suivants, ni sur l'autre appareil.
 */
import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEYS,
  currentBodyweightKg,
  domainMergeRegistry,
  placeByDate,
  upsertSessionByDate,
} from '@kinetic/core';
import { createDevice, FakeSyncServer } from '../support/sync-harness';

const U = 'user-dated';
const BW = STORAGE_KEYS.BODYWEIGHT_ENTRIES;
const MS = STORAGE_KEYS.MEASUREMENTS_ENTRIES;

interface Bw {
  date: string;
  weight: number;
  bodyFatPct: number | null;
  note: string | null;
  updatedAt?: string;
}
const bw = (date: string, weight: number, updatedAt?: string): Bw => ({
  date,
  weight,
  bodyFatPct: null,
  note: null,
  ...(updatedAt ? { updatedAt } : {}),
});

async function pair() {
  const server = new FakeSyncServer();
  const a = await createDevice(server).open(U, { registry: domainMergeRegistry });
  const b = await createDevice(server).open(U, { registry: domainMergeRegistry });
  return { server, a, b };
}

describe('saisies datées : synchro entre deux appareils', () => {
  it('pesée passée sur A, pesée du jour sur B : les deux restent, le poids actuel est celui du jour', async () => {
    const { a, b } = await pair();
    // Ancienne donnée (sans updatedAt) partagée par les deux appareils.
    const base = [bw('2026-11-20', 80)];
    await a.set(BW, base);
    await a.flushPendingWrites();
    await b.pull();

    await a.set(BW, placeByDate(base, bw('2026-10-28', 83, '2026-11-28T09:00:00.000Z')));
    await b.set(BW, placeByDate(base, bw('2026-11-28', 79, '2026-11-28T09:01:00.000Z')));
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    await a.pull();
    await b.pull();

    for (const dev of [a, b]) {
      const v = (await dev.get<Bw[]>(BW)) ?? [];
      expect(v.map((e) => e.date)).toEqual(['2026-10-28', '2026-11-20', '2026-11-28']);
      expect(currentBodyweightKg(v)).toBe(79);
    }
  });

  it('même jour remplacé sur A : la modification la plus récente l emporte, les autres jours restent', async () => {
    const { a, b } = await pair();
    const base = [bw('2026-11-20', 80), bw('2026-11-27', 79)];
    await a.set(BW, base);
    await a.flushPendingWrites();
    await b.pull();

    await a.set(BW, placeByDate(base, bw('2026-11-20', 81.5, '2026-11-28T10:00:00.000Z')));
    await b.set(BW, placeByDate(base, bw('2026-11-26', 79.4, '2026-11-28T09:00:00.000Z')));
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    await a.pull();

    const v = (await a.get<Bw[]>(BW)) ?? [];
    expect(v.map((e) => [e.date, e.weight])).toEqual([
      ['2026-11-20', 81.5],
      ['2026-11-26', 79.4],
      ['2026-11-27', 79],
    ]);
  });

  it('pesée déplacée à une autre date sur A : l ancienne date ne revient pas après synchro', async () => {
    const { a, b } = await pair();
    const base = [bw('2026-11-20', 80), bw('2026-11-27', 79)];
    await a.set(BW, base);
    await a.flushPendingWrites();
    await b.pull();

    // A corrige la date : 20 → 19 (modification) ; B ajoute une pesée passée.
    const moved = placeByDate(
      base,
      bw('2026-11-19', 80, '2026-11-28T10:00:00.000Z'),
      (e) => e.date === '2026-11-19' || e.date === '2026-11-20',
    );
    await a.set(BW, moved);
    await b.set(BW, placeByDate(base, bw('2026-11-01', 82, '2026-11-28T10:01:00.000Z')));
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    await a.pull();
    await b.pull();

    for (const dev of [a, b]) {
      const v = (await dev.get<Bw[]>(BW)) ?? [];
      expect(v.map((e) => e.date)).toEqual(['2026-11-01', '2026-11-19', '2026-11-27']);
    }
  });

  it('mensurations passées sur les deux appareils : aucune perdue, triées par date', async () => {
    const { a, b } = await pair();
    const base = [{ id: 'm0', date: '2026-11-27', waist: 80 }];
    await a.set(MS, base);
    await a.flushPendingWrites();
    await b.pull();
    await a.set(MS, placeByDate(base, { id: 'm1', date: '2026-10-01', waist: 84 }));
    await b.set(MS, placeByDate(base, { id: 'm2', date: '2026-11-10', waist: 82 }));
    await a.flushPendingWrites();
    await b.flushPendingWrites();
    await a.pull();
    const v = (await a.get<Array<{ id: string }>>(MS)) ?? [];
    expect(v.map((e) => e.id)).toEqual(['m1', 'm2', 'm0']);
  });

  it('séance passée ajoutée sur A : nouvelle clé, la séance du jour de B reste intacte', async () => {
    const { server, a, b } = await pair();
    const key = (id: string) => `${STORAGE_KEYS.TRAINING_SESSION_PREFIX}${id}`;
    const today = { id: 's-today', startedAt: '2026-11-28T08:00:00.000Z', name: 'Jour' };
    await b.set(key(today.id), today);
    await b.flushPendingWrites();
    await a.pull();
    const past = { id: 's-past', startedAt: '2026-11-20T17:30:00.000Z', name: 'Passée' };
    await a.set(key(past.id), past);
    await a.flushPendingWrites();
    await b.pull();
    const live = server.live(U);
    expect(live[key(today.id)]).toEqual(today);
    expect(live[key(past.id)]).toEqual(past);
    expect(upsertSessionByDate([today], past).map((s) => s.id)).toEqual(['s-past', 's-today']);
    expect(await b.get(key(today.id))).toEqual(today);
  });
});
