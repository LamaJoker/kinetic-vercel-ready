export {
  EMPTY_SYNC_STATUS,
  syncReasonLabel,
  syncStatusLabel,
  isCloudBackedUp,
} from './sync-status.js';
export type { SyncState, SyncStatus, SyncBlockedEntry } from './sync-status.js';

export {
  lwwStrategy,
  createMergeRegistry,
  defaultMergeRegistry,
  resolveSyncConflict,
  jsonEqual,
  sameKeyState,
} from './merge-strategy.js';
export type {
  SyncKeyState,
  PendingWriteInfo,
  ConflictInput,
  ConflictResolution,
  RecoveryCopy,
  ExtraWrite,
  MergeStrategy,
  MergeRule,
  MergeRegistry,
} from './merge-strategy.js';

// ─── Fusion par domaine (sync.md « Fusion par domaine ») ───
export {
  SYNC_MERGE_RULES,
  DEFAULT_MERGE_RULE,
  ITEM_TOMBSTONE_TTL_DAYS,
  domainMergeRegistry,
  specMergeStrategy,
  sessionKeepBothStrategy,
  sessionConflictCopy,
  conflictCopyId,
  mergeRuleForKey,
  mergeSpecForKey,
  strategyNameForKey,
  isDeviceLocalKey,
  planGuestMerge,
  itemTombstoneKey,
  isItemTombstoneKey,
  collectionKeyOfTombstoneKey,
  asItemTombstones,
  mergeItemTombstoneMaps,
  itemIdFor,
  withItemDeletions,
  pruneItemTombstones,
  stampUpdatedAt,
  deleteCollectionItems,
} from './domain-merge.js';
export type { SyncScope, SyncMergeRule, GuestMergePlan, GuestMergeWrite } from './domain-merge.js';
export {
  mergeValues,
  UNKNOWN_ANCESTOR,
  ABSENT_ANCESTOR,
  knownAncestor,
} from './merge-strategies.js';
export type {
  MergeSpec,
  MergeKind,
  MergeAncestor,
  MergeContext,
  MergeOutcome,
  ItemTombstones,
  CollectionSort,
} from './merge-strategies.js';
