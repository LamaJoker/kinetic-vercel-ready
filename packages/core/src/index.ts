// ─── Validation (shared pure helpers) ────────────────────────
export { validateStorageKey, validateStorageValue } from './validation.js';

// ─── Constants ────────────────────────────────────────────────
export { STORAGE_KEYS } from './constants/storage-keys.js';
export type { StaticStorageKey } from './constants/storage-keys.js';

// ─── CRDT (Vector Clock) ──────────────────────────────────────
export { createClock, incrementClock, mergeClock, compareClocks, resolveConflict } from './crdt.js';
export type { VectorClock, ClockComparison, CRDTValue } from './crdt.js';

// ─── Ports (interfaces) ───────────────────────────────────────
export type { StoragePort, StorageKey } from './ports/storage.port.js';
export type { ClockPort } from './ports/clock.port.js';
export type { IdGeneratorPort } from './ports/id-generator.port.js';
export type { NotifierPort, NotificationPayload, NotificationKind } from './ports/notifier.port.js';
export type { DailyLogSyncPort, DailyLogEntry } from './ports/daily-log-sync.port.js';

// ─── Domain (logique pure) ────────────────────────────────────
export {
  LEVELS,
  REWARDS,
  computeXpState,
  addXp,
  didLevelUp,
  getNewLevel,
  getRewardForLevel,
} from './domain/xp.domain.js';
export type { Level, XpState, Reward, RewardKind } from './domain/xp.domain.js';

export {
  createStreak,
  processActivity,
  isStreakAlive,
  getStreakStatus,
  daysBetween,
} from './domain/streak.domain.js';
export type { StreakState, StreakStatus } from './domain/streak.domain.js';

export {
  createTask,
  completeTask,
  resetRecurringTask,
  canComplete,
  sortByPriority,
  validateTask,
} from './domain/task.domain.js';
export type {
  Task,
  TaskId,
  TaskType,
  TaskPriority,
  CreateTaskInput,
  TaskValidationError,
} from './domain/task.domain.js';

// Nouveaux domaines Nutrition & Program
export * from './domain/nutrition.domain.js';
export * from './domain/program.domain.js';

// Progression & Analytics (v2 — suivi intelligent)
export * from './domain/progression.domain.js';
export * from './domain/analytics.domain.js';
export * from './domain/goals.domain.js';
export * from './domain/workout-generator.domain.js';
export * from './domain/muscle-balance.domain.js';

// ─── Use Cases (orchestration) ────────────────────────────────
export { completeTask_usecase } from './usecases/complete-task.usecase.js';
export type {
  CompleteTaskDeps,
  CompleteTaskInput,
  CompleteTaskResult,
} from './usecases/complete-task.usecase.js';

export { awardXp } from './usecases/award-xp.usecase.js';
export type { AwardXpDeps, AwardXpInput, AwardXpResult } from './usecases/award-xp.usecase.js';

export { resetDailyTasks } from './usecases/reset-daily-tasks.usecase.js';
export type {
  ResetDailyTasksDeps,
  ResetDailyTasksResult,
} from './usecases/reset-daily-tasks.usecase.js';

export { undoTask_usecase } from './usecases/undo-task.usecase.js';
export type { UndoTaskDeps, UndoTaskInput, UndoTaskResult } from './usecases/undo-task.usecase.js';

export { syncDailyLog } from './usecases/sync-daily-log.usecase.js';
export type { SyncDailyLogDeps, SyncDailyLogResult } from './usecases/sync-daily-log.usecase.js';
