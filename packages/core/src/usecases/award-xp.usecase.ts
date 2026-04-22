import type { StoragePort }  from '../ports/storage.port.js';
import type { NotifierPort } from '../ports/notifier.port.js';
import { addXp, computeXpState, didLevelUp } from '../domain/xp.domain.js';

export interface AwardXpDeps {
  storage:  StoragePort;
  notifier: NotifierPort;
}

export interface AwardXpInput {
  amount:          number;
  idempotencyKey?: string;
  silent?:         boolean;
}

export type AwardXpResult =
  | { ok: true;  xpBefore: number; xpAfter: number; leveledUp: boolean; newLevel?: number | undefined; skipped: false }
  | { ok: true;  skipped: true }
  | { ok: false; reason: string };

const KEY_XP          = 'kinetic:xp';
const KEY_AWARDED_IDS = 'kinetic:awarded-ids';

export async function awardXp(
  deps:  AwardXpDeps,
  input: AwardXpInput,
): Promise<AwardXpResult> {
  const { storage, notifier } = deps;

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, reason: `Montant invalide : ${input.amount}` };
  }

  if (input.idempotencyKey) {
    const awardedIds = await storage.get<string[]>(KEY_AWARDED_IDS) ?? [];
    if (awardedIds.includes(input.idempotencyKey)) {
      return { ok: true, skipped: true };
    }
  }

  const xpData  = await storage.get<{ xp: number }>(KEY_XP);
  const xpBefore = xpData?.xp ?? 0;
  const xpAfter  = addXp(xpBefore, input.amount);

  const leveledUp = didLevelUp(xpBefore, xpAfter);
  const newLevel  = leveledUp ? computeXpState(xpAfter).currentLevel : undefined;

  await storage.set(KEY_XP, { xp: xpAfter });

  if (input.idempotencyKey) {
    const awardedIds = await storage.get<string[]>(KEY_AWARDED_IDS) ?? [];
    await storage.set(KEY_AWARDED_IDS, [...awardedIds, input.idempotencyKey]);
  }

  if (!input.silent) {
    notifier.notify({
      kind:    leveledUp ? 'success' : 'info',
      message: leveledUp
        ? `🎉 Niveau ${newLevel} ! +${input.amount} XP`
        : `+${input.amount} XP`,
    });
  }

  return { ok: true, xpBefore, xpAfter, leveledUp, newLevel, skipped: false };
}