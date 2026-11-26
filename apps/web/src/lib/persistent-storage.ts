/**
 * Stockage persistant (navigator.storage.persist) : sans lui, Safari/iOS (7 jours sans
 * visite) et Chrome sous pression peuvent évincer IndexedDB, donc les séances pas encore
 * envoyées au cloud.
 *
 * Demandé APRÈS la première séance enregistrée, pas au lancement : le navigateur accorde
 * plus volontiers la persistance à un site réellement utilisé, et Firefox affiche une
 * demande à l'utilisateur, qui doit comprendre pourquoi. Une seule demande par appareil
 * (mémorisée dans localStorage) ; tout échec est silencieux : l'app marche sans.
 */
import { STORAGE_KEYS } from '@kinetic/core';

export type PersistOutcome = 'granted' | 'denied' | 'already' | 'asked-before' | 'unsupported';

interface PersistEnv {
  storage?: Pick<StorageManager, 'persist' | 'persisted'> | undefined;
  memory?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}

function defaultEnv(): PersistEnv {
  let memory: PersistEnv['memory'];
  try {
    memory = typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    memory = undefined; // localStorage bloqué (navigation privée stricte)
  }
  return {
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
    memory,
  };
}

export async function requestPersistentStorage(
  env: PersistEnv = defaultEnv(),
): Promise<PersistOutcome> {
  const sm = env.storage;
  if (!sm || typeof sm.persist !== 'function' || typeof sm.persisted !== 'function') {
    return 'unsupported';
  }
  try {
    if (await sm.persisted()) return 'already';
    if (env.memory?.getItem(STORAGE_KEYS.PERSIST_ASKED) === '1') return 'asked-before';
    try {
      env.memory?.setItem(STORAGE_KEYS.PERSIST_ASKED, '1');
    } catch {
      /* mémoire indisponible : la demande sera refaite, sans conséquence */
    }
    return (await sm.persist()) ? 'granted' : 'denied';
  } catch (err) {
    console.warn('[storage] persist() indisponible :', err);
    return 'unsupported';
  }
}
