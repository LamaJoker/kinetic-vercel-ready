export type VectorClock = Record<string, number>

export type ClockComparison = 'before' | 'after' | 'equal' | 'concurrent'

export interface CRDTValue<T> {
  value: T
  clock: VectorClock
  deviceId: string
  wallTime: number
}

// ✅ CREATE
export function createClock(deviceId: string): VectorClock {
  return { [deviceId]: 0 }
}

// ✅ INCREMENT
export function incrementClock(clock: VectorClock, deviceId: string): VectorClock {
  return {
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  }
}

// ✅ MERGE
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])

  for (const key of keys) {
    result[key] = Math.max(a[key] ?? 0, b[key] ?? 0)
  }

  return result
}

// ✅ COMPARE (FIXED)
export function compareClocks(a: VectorClock, b: VectorClock): ClockComparison {
  let isBefore = false
  let isAfter = false

  const keys = new Set([...Object.keys(a), ...Object.keys(b)])

  for (const key of keys) {
    const av = a[key] ?? 0
    const bv = b[key] ?? 0

    if (av < bv) isBefore = true
    if (av > bv) isAfter = true
  }

  if (isBefore && !isAfter) return 'before'
  if (isAfter && !isBefore) return 'after'
  if (!isBefore && !isAfter) return 'equal'
  return 'concurrent'
}

// ✅ RESOLVE (FIXED)
export function resolveConflict<T>(
  local: CRDTValue<T>,
  remote: CRDTValue<T>
): CRDTValue<T> {
  const cmp = compareClocks(local.clock, remote.clock)

  if (cmp === 'after') return local
  if (cmp === 'before') return remote

  // concurrent → tie-break
  if (local.wallTime !== remote.wallTime) {
    return local.wallTime > remote.wallTime ? local : remote
  }

  return local.deviceId > remote.deviceId ? local : remote
}
