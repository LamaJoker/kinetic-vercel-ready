/**
 * Revue adversariale « perte de données » : écritures de l'app fondées sur un état
 * LU AVANT une synchro.
 *
 * Les pages et stores de l'app gardent en mémoire ce qu'ils ont lu (`this.templates`,
 * séance ouverte…) et réécrivent la valeur ENTIÈRE de la clé. Si un pull a remplacé
 * la clé entre la lecture et l'écriture, l'écriture partait avec la `base` du pull
 * (version la plus récente) : aucun conflit côté serveur, la modification de l'autre
 * appareil était écrasée sans copie, partout. SyncedStorage détecte désormais ces
 * écritures « périmées » et les fusionne (règles par domaine) avec ce que la synchro
 * a apporté depuis la lecture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@kinetic/core';
import type { SyncedStorage } from '@kinetic/adapters-web';
import { createDevice, FakeSyncServer, type Device } from '../support/sync-harness';
import { syncMerge } from '../../apps/web/src/lib/sync-merge';
import {
  loadSessions,
  loadTemplates,
  saveSession,
  saveTemplates,
  sessionStorageKey,
} from '../../apps/web/src/lib/training/storage';
import type { WorkoutSession, WorkoutTemplate } from '../../apps/web/src/lib/training/types';

const ALICE = 'user-alice';
const TEMPLATES = STORAGE_KEYS.TRAINING_TEMPLATES;

const opened: SyncedStorage[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.dispose();
});

async function open(device: Device): Promise<SyncedStorage> {
  const s = await device.open(ALICE, { loadMerge: async () => syncMerge });
  opened.push(s);
  return s;
}

function template(id: string, name: string): WorkoutTemplate {
  return { id, name, createdAt: '2026-11-01T00:00:00.000Z', exercises: [] };
}

function workout(id: string, name: string, reps = 5): WorkoutSession {
  const at = '2026-11-24T08:00:00.000Z';
  return {
    id,
    name,
    startedAt: at,
    endedAt: '2026-11-24T09:00:00.000Z',
    entries: [
      {
        exerciseId: 'squat',
        sets: [{ setIndex: 0, reps, weightKg: 100, rpe: 8, performedAt: at }],
      },
    ],
  };
}

function cloudTemplateIds(server: FakeSyncServer): string[] {
  return ((server.live(ALICE)[TEMPLATES] as WorkoutTemplate[] | undefined) ?? []).map((t) => t.id);
}

describe('envois successifs sans réponse (tunnel, métro)', () => {
  it('1er envoi appliqué mais réponse perdue, 2e envoi jamais parti : pas de fausse copie « (conflit) », la dernière version reste la séance', async () => {
    const server = new FakeSyncServer();
    const key = sessionStorageKey('w1');
    server.seed(ALICE, key, workout('w1', 'Squat'));
    const phone = createDevice(server);
    const s = await open(phone);
    await s.sync({ ignoreBackoff: true });

    // V1 : envoyée, appliquée par le serveur, réponse perdue.
    await saveSession(s, workout('w1', 'Squat', 6));
    server.dropResponseOnce('sync_push');
    await s.flushPendingWrites({ ignoreBackoff: true });
    expect((server.live(ALICE)[key] as WorkoutSession).entries[0]!.sets[0]!.reps).toBe(6);
    // V2 : réseau coupé, la requête ne part pas.
    await saveSession(s, workout('w1', 'Squat', 7));
    server.networkDown = true;
    await s.flushPendingWrites({ ignoreBackoff: true });
    // V3 au retour du réseau.
    server.networkDown = false;
    await saveSession(s, workout('w1', 'Squat', 8));
    await s.sync({ ignoreBackoff: true });

    const sessions = Object.entries(server.live(ALICE)).filter(([k]) =>
      k.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX),
    );
    expect(sessions).toHaveLength(1);
    expect((server.live(ALICE)[key] as WorkoutSession).entries[0]!.sets[0]!.reps).toBe(8);
    expect(((await s.get(key)) as WorkoutSession).entries[0]!.sets[0]!.reps).toBe(8);
    expect(await s.listRecovery()).toEqual([]);
  });
});

describe('écriture fondée sur un état lu avant un pull', () => {
  it('nouvel appareil : modèles par défaut affichés, 1er pull pendant que la page est ouverte, modification → les modèles du cloud ne sont pas écrasés', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, TEMPLATES, [template('mine', 'Mon programme')]);
    const phone = createDevice(server);
    const s = await open(phone);

    // La page Séances s'affiche avant la synchro : modèles par défaut en mémoire.
    const onScreen = await loadTemplates(s);
    expect(onScreen.some((t) => t.id === 'mine')).toBe(false);

    // Premier pull (afterFirstRender) pendant que la page reste ouverte.
    await s.sync({ ignoreBackoff: true });

    // L'utilisateur duplique / ajoute un modèle depuis la liste affichée.
    await saveTemplates(s, [...onScreen, template('new', 'Ajouté')]);
    await s.sync({ ignoreBackoff: true });

    const ids = cloudTemplateIds(server);
    expect(ids).toContain('mine');
    expect(ids).toContain('new');
  });

  it('liste en mémoire périmée après un pull périodique : le modèle ajouté sur l autre appareil n est pas perdu', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, TEMPLATES, [template('t1', 'Haut du corps')]);
    const a = createDevice(server);
    const b = createDevice(server);
    const sa = await open(a);
    const sb = await open(b);
    await sa.sync({ ignoreBackoff: true });
    await sb.sync({ ignoreBackoff: true });

    // A : page Séances ouverte, liste chargée.
    const onScreenA = await loadTemplates(sa);
    // B ajoute un modèle et synchronise.
    await saveTemplates(sb, [...(await loadTemplates(sb)), template('t2', 'Jambes')]);
    await sb.sync({ ignoreBackoff: true });
    expect(cloudTemplateIds(server)).toEqual(['t1', 't2']);

    // Pull périodique de A (60 s) : la page n'est pas rechargée.
    await sa.sync();
    // A duplique t1 depuis la liste affichée (seances.page duplicateTemplate).
    await saveTemplates(sa, [...onScreenA, template('t1-copy', 'Haut du corps (copie)')]);
    await sa.sync({ ignoreBackoff: true });

    const ids = cloudTemplateIds(server);
    expect(ids).toContain('t2');
    expect(ids).toContain('t1-copy');
    expect(ids).toContain('t1');
    // Et B finit avec la même liste.
    await sb.sync();
    expect((await loadTemplates(sb)).map((t) => t.id).sort()).toEqual(ids.slice().sort());
  });

  it('suppression dans une liste périmée : la suppression tient, l ajout de l autre appareil aussi', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, TEMPLATES, [template('t1', 'Haut'), template('t3', 'Bas')]);
    const a = createDevice(server);
    const b = createDevice(server);
    const sa = await open(a);
    const sb = await open(b);
    await sa.sync({ ignoreBackoff: true });
    await sb.sync({ ignoreBackoff: true });

    const onScreenA = await loadTemplates(sa);
    await saveTemplates(sb, [...(await loadTemplates(sb)), template('t2', 'Jambes')]);
    await sb.sync({ ignoreBackoff: true });
    await sa.sync();
    // A supprime t3 depuis la liste affichée (seances.page deleteTemplate).
    await saveTemplates(
      sa,
      onScreenA.filter((t) => t.id !== 't3'),
    );
    await sa.sync({ ignoreBackoff: true });

    expect(cloudTemplateIds(server).sort()).toEqual(['t1', 't2']);
  });

  it('séance ouverte modifiée sur deux appareils, pull entre la lecture et l enregistrement : les deux versions sont conservées', async () => {
    const server = new FakeSyncServer();
    const key = sessionStorageKey('w1');
    server.seed(ALICE, key, workout('w1', 'Squat'));
    const a = createDevice(server);
    const b = createDevice(server);
    const sa = await open(a);
    const sb = await open(b);
    await sa.sync({ ignoreBackoff: true });
    await sb.sync({ ignoreBackoff: true });

    // A ouvre la séance pour la corriger.
    const openedOnA = (await loadSessions(sa)).find((w) => w.id === 'w1')!;
    // B la renomme et synchronise ; A reçoit la nouvelle version par le pull périodique.
    await saveSession(sb, { ...workout('w1', 'Squat lourd') });
    await sb.sync({ ignoreBackoff: true });
    await sa.sync();
    // A enregistre SA correction (8 répétitions) faite sur la version affichée.
    await saveSession(sa, { ...openedOnA, entries: workout('w1', 'Squat', 8).entries });
    await sa.sync({ ignoreBackoff: true });

    const cloud = Object.entries(server.live(ALICE))
      .filter(([k]) => k.startsWith(STORAGE_KEYS.TRAINING_SESSION_PREFIX))
      .map(([, v]) => v as WorkoutSession);
    // La modification de B n'a pas disparu…
    expect(cloud.some((w) => w.name === 'Squat lourd')).toBe(true);
    // … ni celle de A.
    expect(cloud.some((w) => w.entries[0]!.sets[0]!.reps === 8)).toBe(true);
  });

  it('écriture sans lecture préalable (nouvelle clé) ou fondée sur un état à jour : comportement inchangé, aucune copie', async () => {
    const server = new FakeSyncServer();
    server.seed(ALICE, TEMPLATES, [template('t1', 'Haut')]);
    const a = createDevice(server);
    const sa = await open(a);
    await sa.sync({ ignoreBackoff: true });
    const list = await loadTemplates(sa);
    await saveTemplates(sa, [...list, template('t2', 'Bas')]);
    // Relecture après sa propre écriture, puis nouvelle écriture : rien de périmé.
    const again = await loadTemplates(sa);
    await saveTemplates(
      sa,
      again.filter((t) => t.id !== 't1'),
    );
    await saveSession(sa, workout('w9', 'Nouvelle'));
    await sa.sync({ ignoreBackoff: true });
    expect(cloudTemplateIds(server)).toEqual(['t2']);
    expect((await sa.listRecovery()).length).toBe(0);
  });
});
