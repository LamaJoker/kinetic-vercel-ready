/**
 * Flux critique des séances (QA-06) : enregistrement, édition, annulation d'édition et
 * suppression, avec les fonctions RÉELLES de lib/training (`saveSession`, `deleteSession`,
 * `loadSessions`, séance en cours) sur la pile réelle de l'app : deps.factory →
 * SyncedStorage (IndexedDB en mémoire fidèle) → SupabaseSyncRemote → faux serveur 010.
 *
 * Chaque test reproduit l'ordre d'appels de la page Séances (seances.page.ts) :
 *  - « Terminer » : séance finalisée PUIS enregistrée, et seulement ensuite la séance
 *    en cours est effacée (saveCurrentSession) ;
 *  - « Modifier » : brouillon enregistré d'un bloc sous la même clé (saveEditedSession) ;
 *    « Annuler » ne touche pas au stockage (cancelEditSession) ;
 *  - « Supprimer » : une seule clé supprimée, propagée en tombstone (deleteSession).
 *
 * F14 (audit sync) : « Restaurer depuis le cloud » (syncFromRemote force) alors qu'une
 * suppression ou une modification attend l'envoi — la modification locale n'est jamais
 * écrasée en silence, et local et cloud finissent identiques.
 */
import { describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import {
  deleteSession,
  loadSessions,
  saveSession,
  sessionStorageKey,
} from '../../apps/web/src/lib/training/storage';
import {
  loadActiveSession,
  snapshotActiveSession,
  writeActiveSession,
} from '../../apps/web/src/lib/training/active-session';
import type { WorkoutSession } from '../../apps/web/src/lib/training/types';
import {
  FakeSyncServer,
  appSessions,
  cloudSessions,
  phoneOf,
  workout,
  type Phone,
} from '../support/phone';

const ALICE = 'user-alice';

// Comme dans l'app : SyncedStorage prévient `window` (EVENT_SYNC_APPLIED) et
// loadSessions y écoute pour oublier sa liste gardée. Chaque téléphone de test a son
// propre EventTarget : ses événements de synchro sont relayés vers ce `window`.
vi.stubGlobal('window', new EventTarget());

async function phoneOn(server: FakeSyncServer): Promise<Phone> {
  const phone = await phoneOf(server, ALICE);
  phone.events.addEventListener(STORAGE_KEYS.EVENT_SYNC_APPLIED, (e) => {
    const detail = (e as CustomEvent<unknown>).detail;
    window.dispatchEvent(new CustomEvent(STORAGE_KEYS.EVENT_SYNC_APPLIED, { detail }));
  });
  return phone;
}

/** Séance en cours, telle que la page la tient avant « Terminer ». */
function inProgress(id: string, sets: number): WorkoutSession {
  return {
    id,
    name: 'Push A',
    startedAt: '2026-11-25T09:00:00.000Z',
    entries: [
      {
        exerciseId: 'bench',
        sets: Array.from({ length: sets }, (_, i) => ({
          setIndex: i,
          reps: 8,
          weightKg: 80,
          rpe: 8,
          performedAt: `2026-11-25T09:${String(5 + i * 4).padStart(2, '0')}:00.000Z`,
        })),
      },
    ],
  };
}

/** Même finalisation que saveCurrentSession (fin, durée). */
function finalize(current: WorkoutSession, endedAt: string): WorkoutSession {
  const durationMin = Math.max(
    0,
    Math.round((Date.parse(endedAt) - Date.parse(current.startedAt)) / 60000),
  );
  return { ...current, endedAt, durationMin };
}

/** « Terminer » : persistance d'abord, puis effacement de la séance en cours. */
async function finish(phone: Phone, current: WorkoutSession): Promise<WorkoutSession> {
  const finalized = finalize(current, '2026-11-25T10:00:00.000Z');
  await saveSession(phone.storage, finalized);
  await writeActiveSession(phone.storage, null);
  return finalized;
}

describe('Séances : enregistrement (saveCurrentSession)', () => {
  it('séance terminée : une clé par séance, séance en cours effacée, envoyée au cloud', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    const current = inProgress('s1', 3);
    const snap = snapshotActiveSession(
      {
        session: current,
        restEndsAtMs: 0,
        restTotalSec: 0,
        restPresetSec: 120,
        activeExerciseId: 'bench',
      },
      phone.clock.ms,
    );
    await writeActiveSession(phone.storage, snap);
    expect(await loadActiveSession(phone.storage)).not.toBeNull();

    const saved = await finish(phone, current);

    expect(saved.durationMin).toBe(60);
    const list = await loadSessions(phone.storage);
    expect(list.map((s) => s.id)).toEqual(['s1']);
    expect(list[0]!.entries[0]!.sets).toHaveLength(3);
    expect(await phone.storage.get(sessionStorageKey('s1'))).toMatchObject({
      endedAt: saved.endedAt,
    });
    expect(await loadActiveSession(phone.storage)).toBeNull();

    await phone.storage.flushPendingWrites();
    expect(cloudSessions(server, ALICE)).toEqual({ s1: 'Push A' });
    // La séance en cours n'est jamais envoyée au cloud (clé locale uniquement).
    expect(server.row(ALICE, STORAGE_KEYS.TRAINING_ACTIVE_SESSION)).toBeNull();
    expect(await phone.storage.pendingCount()).toBe(0);
    phone.dispose();
  });

  it('écriture refusée (stockage plein) : erreur remontée, séance en cours GARDÉE, rien de fantôme', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    const current = inProgress('s1', 2);
    const snap = snapshotActiveSession(
      {
        session: current,
        restEndsAtMs: 0,
        restTotalSec: 0,
        restPresetSec: 120,
        activeExerciseId: 'bench',
      },
      phone.clock.ms,
    );
    await writeActiveSession(phone.storage, snap);
    const pendingBefore = await phone.storage.pendingCount();

    phone.fake.failNext((op) => op.store === 'outbox' && op.kind === 'put', 'QuotaExceededError');
    await expect(finish(phone, current)).rejects.toMatchObject({ name: 'QuotaExceededError' });

    // La page n'efface la séance en cours qu'APRÈS l'enregistrement : rien n'est perdu.
    expect(await loadActiveSession(phone.storage)).not.toBeNull();
    expect(await loadSessions(phone.storage)).toEqual([]);
    expect(await phone.storage.pendingCount()).toBe(pendingBefore);

    // Nouvel essai (espace libéré) : la séance est enregistrée normalement.
    await finish(phone, current);
    expect(Object.keys(await appSessions(phone.storage))).toEqual(['s1']);
    phone.dispose();
  });

  it('double appui pendant l enregistrement : une seule séance, une seule ligne cloud', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    const finalized = finalize(inProgress('s1', 2), '2026-11-25T10:00:00.000Z');
    await Promise.all([
      saveSession(phone.storage, finalized),
      saveSession(phone.storage, finalized),
    ]);
    expect((await loadSessions(phone.storage)).map((s) => s.id)).toEqual(['s1']);
    await phone.storage.flushPendingWrites();
    expect(Object.keys(cloudSessions(server, ALICE))).toEqual(['s1']);
    phone.dispose();
  });
});

describe('Séances : édition et annulation (saveEditedSession / cancelEditSession)', () => {
  it('séance passée modifiée : même clé réécrite, liste sans doublon, l autre appareil voit la modification', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOn(server);
    const b = await phoneOn(server);
    const original = await finish(a, inProgress('s1', 2));
    await a.storage.sync();
    await b.storage.sync();
    expect(await appSessions(b.storage)).toEqual({ s1: 'Push A' });

    // Brouillon : série oubliée ajoutée, nom changé, puis « Enregistrer ».
    const firstSet = original.entries[0]!.sets[0]!;
    const draft: WorkoutSession = {
      ...original,
      name: 'Push A (lourd)',
      entries: [
        {
          ...original.entries[0]!,
          sets: [...original.entries[0]!.sets, { ...firstSet, setIndex: 2, weightKg: 85 }],
        },
      ],
    };
    await saveSession(a.storage, draft);

    const list = await loadSessions(a.storage);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', name: 'Push A (lourd)' });
    expect(list[0]!.entries[0]!.sets).toHaveLength(3);

    await a.storage.sync();
    await b.storage.sync();
    const onB = await loadSessions(b.storage);
    expect(onB).toHaveLength(1);
    expect(onB[0]!.entries[0]!.sets.map((s) => s.weightKg)).toEqual([80, 80, 85]);
    a.dispose();
    b.dispose();
  });

  it('annulation : le brouillon modifié n est jamais écrit (ni localement ni dans l outbox)', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    await finish(phone, inProgress('s1', 2));
    await phone.storage.flushPendingWrites();

    // La page édite une copie (editingSession) ; la liste reçue est déjà une copie.
    const [loaded] = await loadSessions(phone.storage);
    const draft = loaded!;
    draft.name = 'Brouillon abandonné';
    draft.entries[0]!.sets.pop();
    // « Annuler » : brouillon jeté, aucune écriture.

    expect(await phone.storage.pendingCount()).toBe(0);
    const again = await loadSessions(phone.storage);
    expect(again[0]).toMatchObject({ name: 'Push A' });
    expect(again[0]!.entries[0]!.sets).toHaveLength(2);
    expect(cloudSessions(server, ALICE)).toEqual({ s1: 'Push A' });
    phone.dispose();
  });
});

describe('Séances : suppression (deleteSession)', () => {
  it('une seule séance supprimée, les autres intactes ; tombstone propagée sans résurrection', async () => {
    const server = new FakeSyncServer();
    const a = await phoneOn(server);
    const b = await phoneOn(server);
    await saveSession(a.storage, workout('w1', 'Bras', 5, 20));
    await saveSession(a.storage, workout('w2', 'Jambes', 5, 21));
    await a.storage.sync();
    await b.storage.sync();

    await deleteSession(a.storage, 'w1');
    expect(await appSessions(a.storage)).toEqual({ w2: 'Jambes' });
    await a.storage.sync();
    expect(server.row(ALICE, sessionStorageKey('w1'))).toMatchObject({ deleted: true });

    await b.storage.sync();
    expect(await appSessions(b.storage)).toEqual({ w2: 'Jambes' });
    // Plusieurs synchros plus tard : toujours absente.
    for (let i = 0; i < 2; i++) for (const p of [a, b]) await p.storage.sync();
    expect(await appSessions(a.storage)).toEqual({ w2: 'Jambes' });
    a.dispose();
    b.dispose();
  });

  it('suppression d une séance inconnue : sans effet ni erreur', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    await saveSession(phone.storage, workout('w1', 'Bras'));
    await expect(deleteSession(phone.storage, 'absente')).resolves.toBeUndefined();
    expect(await appSessions(phone.storage)).toEqual({ w1: 'Bras' });
    phone.dispose();
  });
});

describe('F14 — restauration forcée avec des écritures en attente', () => {
  it('suppression hors-ligne puis « Restaurer depuis le cloud » : la séance reste supprimée partout', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    await saveSession(phone.storage, workout('w1', 'Bras', 5, 20));
    await saveSession(phone.storage, workout('w2', 'Jambes', 5, 21));
    await phone.storage.flushPendingWrites();

    phone.offline();
    await deleteSession(phone.storage, 'w1');
    expect(await phone.storage.pendingCount()).toBe(1);
    phone.online();

    await phone.storage.syncFromRemote({ force: true }); // Profil › Restaurer
    // Avant la refonte : la séance réapparaissait localement alors que le cloud la supprimait.
    expect(await appSessions(phone.storage)).toEqual({ w2: 'Jambes' });
    expect(server.row(ALICE, sessionStorageKey('w1'))).toMatchObject({ deleted: true });
    expect(await phone.storage.pendingCount()).toBe(0);

    // Un autre appareil et un redémarrage complet confirment la convergence.
    const other = await phoneOn(server);
    expect(await appSessions(other.storage)).toEqual({ w2: 'Jambes' });
    phone.kill();
    await phone.startup();
    expect(await appSessions(phone.storage)).toEqual({ w2: 'Jambes' });
    phone.dispose();
    other.dispose();
  });

  it('modification hors-ligne puis restauration forcée : la modification n est pas écrasée et part au cloud', async () => {
    const server = new FakeSyncServer();
    const phone = await phoneOn(server);
    await saveSession(phone.storage, workout('w1', 'Bras', 5, 20));
    await phone.storage.flushPendingWrites();

    phone.offline();
    await saveSession(phone.storage, workout('w1', 'Bras', 9, 20));
    phone.online();
    await phone.storage.syncFromRemote({ force: true });

    const [local] = await loadSessions(phone.storage);
    expect(local!.entries[0]!.sets[0]!.reps).toBe(9);
    const cloud = server.live(ALICE)[sessionStorageKey('w1')] as WorkoutSession;
    expect(cloud.entries[0]!.sets[0]!.reps).toBe(9);
    expect(await phone.storage.pendingCount()).toBe(0);
    phone.dispose();
  });
});
