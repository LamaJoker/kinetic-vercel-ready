/**
 * Task Domain — entités et logique métier des tâches Kinetic.
 *
 * Types de tâches :
 *   - one-time  : complétée une fois, ne revient pas
 *   - recurring : se réinitialise chaque jour (routine vitalité)
 *   - habit     : suivi quotidien avec historique
 *
 * Le domaine est pur : pas d'I/O, pas de side effects.
 */

// ─── Entités ─────────────────────────────────────────────────────────────────

export type TaskId       = string;
export type TaskType     = 'one-time' | 'recurring' | 'habit';
export type TaskPriority = 'high' | 'med' | 'low';

export interface Task {
  readonly id:          TaskId;
  readonly title:       string;
  readonly description: string;
  readonly type:        TaskType;
  readonly xp:          number;         // XP accordé à la complétion
  readonly priority:    TaskPriority;
  readonly icon:        string;         // Emoji ou identifiant d'icône
  readonly createdAt:   string;         // ISO date "YYYY-MM-DD"
  readonly done:        boolean;
  readonly completedAt: string | null;  // ISO date
  readonly completionCount: number;     // Total de complétions (pour recurring)
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface TaskValidationError {
  field:   string;
  message: string;
}

export function validateTask(data: Partial<Task>): TaskValidationError[] {
  const errors: TaskValidationError[] = [];

  if (!data.title?.trim()) {
    errors.push({ field: 'title', message: 'Le titre est requis.' });
  } else if (data.title.trim().length > 100) {
    errors.push({ field: 'title', message: 'Le titre ne doit pas dépasser 100 caractères.' });
  }

  if (data.xp !== undefined) {
    if (!Number.isInteger(data.xp) || data.xp <= 0 || data.xp > 1000) {
      errors.push({ field: 'xp', message: 'Le XP doit être un entier entre 1 et 1000.' });
    }
  }

  if (data.type && !(['one-time', 'recurring', 'habit'] as const).includes(data.type)) {
    errors.push({ field: 'type', message: 'Type de tâche invalide.' });
  }

  if (data.priority && !(['high', 'med', 'low'] as const).includes(data.priority)) {
    errors.push({ field: 'priority', message: 'Priorité invalide.' });
  }

  return errors;
}

// ─── Opérations pures ─────────────────────────────────────────────────────────

/**
 * canComplete — retourne true si la tâche peut être complétée.
 * Règles :
 *   - one-time  : seulement si pas encore done
 *   - recurring : toujours (le reset se fait côté use case)
 *   - habit     : toujours
 */
export function canComplete(task: Task): boolean {
  if (task.type === 'one-time') return !task.done;
  return true;
}

/**
 * completeTask — retourne une nouvelle tâche marquée comme done.
 * Immutable — ne mute jamais la tâche originale.
 */
export function completeTask(task: Task, completedAtIso: string): Task {
  if (!canComplete(task)) {
    throw new Error(`La tâche "${task.id}" ne peut pas être complétée.`);
  }

  return {
    ...task,
    done:             true,
    completedAt:      completedAtIso,
    completionCount:  task.completionCount + 1,
  };
}

/**
 * resetRecurringTask — remet à zéro une tâche récurrente pour un nouveau jour.
 */
export function resetRecurringTask(task: Task): Task {
  if (task.type !== 'recurring' && task.type !== 'habit') {
    throw new Error(`Seules les tâches recurring/habit peuvent être réinitialisées.`);
  }

  return {
    ...task,
    done:        false,
    completedAt: null,
  };
}

/**
 * sortByPriority — comparateur pour trier les tâches par priorité.
 */
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  med:  1,
  low:  2,
};

export function sortByPriority(a: Task, b: Task): number {
  const diff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (diff !== 0) return diff;
  // Secondaire : non-done avant done
  if (a.done !== b.done) return a.done ? 1 : -1;
  // Tertiaire : titre alphabétique
  return a.title.localeCompare(b.title);
}

// ─── Constructeur ─────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  id:           TaskId;
  title:        string;
  description?: string;
  type?:        TaskType;
  xp?:          number;
  priority?:    TaskPriority;
  icon?:        string;
  createdAt:    string;
}

export function createTask(input: CreateTaskInput): Task {
  const errors = validateTask(input);
  if (errors.length > 0) {
    throw new Error(`Tâche invalide : ${errors.map((e) => e.message).join(', ')}`);
  }

  return {
    id:               input.id,
    title:            input.title.trim(),
    description:      input.description?.trim() ?? '',
    type:             input.type     ?? 'recurring',
    xp:               input.xp      ?? 50,
    priority:         input.priority ?? 'med',
    icon:             input.icon     ?? '✅',
    createdAt:        input.createdAt,
    done:             false,
    completedAt:      null,
    completionCount:  0,
  };
}
