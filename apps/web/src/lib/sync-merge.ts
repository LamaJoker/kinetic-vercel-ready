/**
 * Règles de fusion par domaine pour le client de synchro, chargées À LA DEMANDE
 * (premier conflit, réconciliation, liaison invité) : hors du bundle de démarrage.
 */
import { domainMergeRegistry, planGuestMerge } from '@kinetic/core';
import type { MergeModule } from '@kinetic/adapters-web';

export const syncMerge: MergeModule = { registry: domainMergeRegistry, planGuestMerge };
