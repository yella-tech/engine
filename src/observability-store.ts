import type Database from 'better-sqlite3'
import type {
  DurationHistogram,
  DurationStats,
  EngineEvent,
  EngineObservabilityBucket,
  EngineObservabilityError,
  EngineObservabilityQuery,
  EngineObservabilityReport,
  EngineObservabilitySummary,
  Run,
} from './types.js'

const DURATION_BOUNDS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const
const HISTOGRAM_KEYS = ['le10ms', 'le50ms', 'le100ms', 'le250ms', 'le500ms', 'le1000ms', 'le2500ms', 'le5000ms', 'le10000ms', 'gt10000ms'] as const
type HistogramKey = (typeof HISTOGRAM_KEYS)[number]

export const ENGINE_OBSERVABILITY_BASE_BUCKET_MS = 5 * 60_000
const DEFAULT_OBSERVABILITY_WINDOW_MS = 24 * 60 * 60_000
const DEFAULT_ERROR_LIMIT = 20
const DEFAULT_FLUSH_INTERVAL_MS = 10_000

type RollupRow = {
  bucketStart: number
  bucketSizeMs: number
  runStartedCount: number
  runCompletedCount: number
  runFailedCount: number
  runRetriedCount: number
  runDeadLetterCount: number
  runResumedCount: number
  effectCompletedCount: number
  effectFailedCount: number
  effectReplayedCount: number
  leaseReclaimCount: number
  internalErrorCount: number
  runDurationSumMs: number
  runDurationCount: number
  runDurationMinMs: number | null
  runDurationMaxMs: number | null
  effectDurationSumMs: number
  effectDurationCount: number
  effectDurationMinMs: number | null
  effectDurationMaxMs: number | null
  runDurationHistogram: DurationHistogram
  effectDurationHistogram: DurationHistogram
}

export interface EngineObservabilityStore {
  upsertRollups(rows: RollupRow[]): void
  listRollups(from: number, to: number): RollupRow[]
  insertError(error: Omit<EngineObservabilityError, 'id'>): void
  listErrors(from: number, to: number, limit: number): EngineObservabilityError[]
}

function emptyHistogram(): DurationHistogram {
  return {
    le10ms: 0,
    le50ms: 0,
    le100ms: 0,
    le250ms: 0,
    le500ms: 0,
    le1000ms: 0,
    le2500ms: 0,
    le5000ms: 0,
    le10000ms: 0,
    gt10000ms: 0,
  }
}

function cloneHistogram(histogram: DurationHistogram): DurationHistogram {
  return { ...histogram }
}

function cloneRollup(row: RollupRow): RollupRow {
  return {
    ...row,
    runDurationHistogram: cloneHistogram(row.runDurationHistogram),
    effectDurationHistogram: cloneHistogram(row.effectDurationHistogram),
  }
}

function emptyRollup(bucketStart: number, bucketSizeMs: number): RollupRow {
  return {
    bucketStart,
    bucketSizeMs,
    runStartedCount: 0,
    runCompletedCount: 0,
    runFailedCount: 0,
    runRetriedCount: 0,
    runDeadLetterCount: 0,
    runResumedCount: 0,
    effectCompletedCount: 0,
    effectFailedCount: 0,
    effectReplayedCount: 0,
    leaseReclaimCount: 0,
    internalErrorCount: 0,
    runDurationSumMs: 0,
    runDurationCount: 0,
    runDurationMinMs: null,
    runDurationMaxMs: null,
    effectDurationSumMs: 0,
    effectDurationCount: 0,
    effectDurationMinMs: null,
    effectDurationMaxMs: null,
    runDurationHistogram: emptyHistogram(),
    effectDurationHistogram: emptyHistogram(),
  }
}

function mergeHistogram(target: DurationHistogram, source: DurationHistogram): void {
  for (const key of HISTOGRAM_KEYS) {
    target[key] += source[key]
  }
}

function mergeMin(current: number | null, next: number | null): number | null {
  if (current === null) return next
  if (next === null) return current
  return Math.min(current, next)
}

function mergeMax(current: number | null, next: number | null): number | null {
  if (current === null) return next
  if (next === null) return current
  return Math.max(current, next)
}

function mergeRollup(target: RollupRow, source: RollupRow): void {
  target.runStartedCount += source.runStartedCount
  target.runCompletedCount += source.runCompletedCount
  target.runFailedCount += source.runFailedCount
  target.runRetriedCount += source.runRetriedCount
  target.runDeadLetterCount += source.runDeadLetterCount
  target.runResumedCount += source.runResumedCount
  target.effectCompletedCount += source.effectCompletedCount
  target.effectFailedCount += source.effectFailedCount
  target.effectReplayedCount += source.effectReplayedCount
  target.leaseReclaimCount += source.leaseReclaimCount
  target.internalErrorCount += source.internalErrorCount

  target.runDurationSumMs += source.runDurationSumMs
  target.runDurationCount += source.runDurationCount
  target.runDurationMinMs = mergeMin(target.runDurationMinMs, source.runDurationMinMs)
  target.runDurationMaxMs = mergeMax(target.runDurationMaxMs, source.runDurationMaxMs)

  target.effectDurationSumMs += source.effectDurationSumMs
  target.effectDurationCount += source.effectDurationCount
  target.effectDurationMinMs = mergeMin(target.effectDurationMinMs, source.effectDurationMinMs)
  target.effectDurationMaxMs = mergeMax(target.effectDurationMaxMs, source.effectDurationMaxMs)

  mergeHistogram(target.runDurationHistogram, source.runDurationHistogram)
  mergeHistogram(target.effectDurationHistogram, source.effectDurationHistogram)
}

function observeDuration(histogram: DurationHistogram, durationMs: number): void {
  if (durationMs <= DURATION_BOUNDS_MS[0]) {
    histogram.le10ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[1]) {
    histogram.le50ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[2]) {
    histogram.le100ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[3]) {
    histogram.le250ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[4]) {
    histogram.le500ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[5]) {
    histogram.le1000ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[6]) {
    histogram.le2500ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[7]) {
    histogram.le5000ms++
  } else if (durationMs <= DURATION_BOUNDS_MS[8]) {
    histogram.le10000ms++
  } else {
    histogram.gt10000ms++
  }
}

function addRunDuration(row: RollupRow, durationMs: number): void {
  row.runDurationSumMs += durationMs
  row.runDurationCount++
  row.runDurationMinMs = row.runDurationMinMs === null ? durationMs : Math.min(row.runDurationMinMs, durationMs)
  row.runDurationMaxMs = row.runDurationMaxMs === null ? durationMs : Math.max(row.runDurationMaxMs, durationMs)
  observeDuration(row.runDurationHistogram, durationMs)
}

function addEffectDuration(row: RollupRow, durationMs: number): void {
  row.effectDurationSumMs += durationMs
  row.effectDurationCount++
  row.effectDurationMinMs = row.effectDurationMinMs === null ? durationMs : Math.min(row.effectDurationMinMs, durationMs)
  row.effectDurationMaxMs = row.effectDurationMaxMs === null ? durationMs : Math.max(row.effectDurationMaxMs, durationMs)
  observeDuration(row.effectDurationHistogram, durationMs)
}

function percentileFromHistogram(histogram: DurationHistogram, percentile: number): number | null {
  const total = HISTOGRAM_KEYS.reduce((count, key) => count + histogram[key], 0)
  if (total === 0) return null
  const target = Math.max(1, Math.ceil(total * percentile))
  let cumulative = 0
  for (let i = 0; i < HISTOGRAM_KEYS.length; i++) {
    cumulative += histogram[HISTOGRAM_KEYS[i]]
    if (cumulative >= target) {
      return i < DURATION_BOUNDS_MS.length ? DURATION_BOUNDS_MS[i] : DURATION_BOUNDS_MS[DURATION_BOUNDS_MS.length - 1]
    }
  }
  return DURATION_BOUNDS_MS[DURATION_BOUNDS_MS.length - 1]
}

function buildDurationStats(sumMs: number, count: number, minMs: number | null, maxMs: number | null, histogram: DurationHistogram): DurationStats {
  return {
    count,
    sumMs,
    minMs,
    maxMs,
    avgMs: count > 0 ? sumMs / count : null,
    p50Ms: percentileFromHistogram(histogram, 0.5),
    p95Ms: percentileFromHistogram(histogram, 0.95),
    histogram: cloneHistogram(histogram),
  }
}

function successRate(successes: number, failures: number): number | null {
  const total = successes + failures
  return total > 0 ? successes / total : null
}

function toPublicBucket(row: RollupRow): EngineObservabilityBucket {
  return {
    bucketStart: row.bucketStart,
    bucketSizeMs: row.bucketSizeMs,
    runs: {
      started: row.runStartedCount,
      completed: row.runCompletedCount,
      failed: row.runFailedCount,
      retried: row.runRetriedCount,
      deadLetters: row.runDeadLetterCount,
      resumed: row.runResumedCount,
      successRate: successRate(row.runCompletedCount, row.runFailedCount),
      duration: buildDurationStats(row.runDurationSumMs, row.runDurationCount, row.runDurationMinMs, row.runDurationMaxMs, row.runDurationHistogram),
    },
    effects: {
      completed: row.effectCompletedCount,
      failed: row.effectFailedCount,
      replayed: row.effectReplayedCount,
      successRate: successRate(row.effectCompletedCount, row.effectFailedCount),
      duration: buildDurationStats(row.effectDurationSumMs, row.effectDurationCount, row.effectDurationMinMs, row.effectDurationMaxMs, row.effectDurationHistogram),
    },
    system: {
      leaseReclaims: row.leaseReclaimCount,
      internalErrors: row.internalErrorCount,
    },
  }
}

function summarizeBuckets(buckets: EngineObservabilityBucket[], recentErrorCount: number): EngineObservabilitySummary {
  const aggregate = emptyRollup(0, 0)
  for (const bucket of buckets) {
    mergeRollup(aggregate, {
      bucketStart: 0,
      bucketSizeMs: 0,
      runStartedCount: bucket.runs.started,
      runCompletedCount: bucket.runs.completed,
      runFailedCount: bucket.runs.failed,
      runRetriedCount: bucket.runs.retried,
      runDeadLetterCount: bucket.runs.deadLetters,
      runResumedCount: bucket.runs.resumed,
      effectCompletedCount: bucket.effects.completed,
      effectFailedCount: bucket.effects.failed,
      effectReplayedCount: bucket.effects.replayed,
      leaseReclaimCount: bucket.system.leaseReclaims,
      internalErrorCount: bucket.system.internalErrors,
      runDurationSumMs: bucket.runs.duration.sumMs,
      runDurationCount: bucket.runs.duration.count,
      runDurationMinMs: bucket.runs.duration.minMs,
      runDurationMaxMs: bucket.runs.duration.maxMs,
      effectDurationSumMs: bucket.effects.duration.sumMs,
      effectDurationCount: bucket.effects.duration.count,
      effectDurationMinMs: bucket.effects.duration.minMs,
      effectDurationMaxMs: bucket.effects.duration.maxMs,
      runDurationHistogram: cloneHistogram(bucket.runs.duration.histogram),
      effectDurationHistogram: cloneHistogram(bucket.effects.duration.histogram),
    })
  }

  return {
    runs: {
      started: aggregate.runStartedCount,
      completed: aggregate.runCompletedCount,
      failed: aggregate.runFailedCount,
      retried: aggregate.runRetriedCount,
      deadLetters: aggregate.runDeadLetterCount,
      resumed: aggregate.runResumedCount,
      successRate: successRate(aggregate.runCompletedCount, aggregate.runFailedCount),
      duration: buildDurationStats(
        aggregate.runDurationSumMs,
        aggregate.runDurationCount,
        aggregate.runDurationMinMs,
        aggregate.runDurationMaxMs,
        aggregate.runDurationHistogram,
      ),
    },
    effects: {
      completed: aggregate.effectCompletedCount,
      failed: aggregate.effectFailedCount,
      replayed: aggregate.effectReplayedCount,
      successRate: successRate(aggregate.effectCompletedCount, aggregate.effectFailedCount),
      duration: buildDurationStats(
        aggregate.effectDurationSumMs,
        aggregate.effectDurationCount,
        aggregate.effectDurationMinMs,
        aggregate.effectDurationMaxMs,
        aggregate.effectDurationHistogram,
      ),
    },
    system: {
      leaseReclaims: aggregate.leaseReclaimCount,
      internalErrors: aggregate.internalErrorCount,
      recentErrorCount,
    },
  }
}

function bucketStartFor(timestamp: number, bucketSizeMs: number): number {
  return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createMemoryEngineObservabilityStore(): EngineObservabilityStore {
  const rollups = new Map<string, RollupRow>()
  const errors: EngineObservabilityError[] = []
  let nextErrorId = 1

  return {
    upsertRollups(rows) {
      for (const row of rows) {
        const key = `${row.bucketSizeMs}:${row.bucketStart}`
        const existing = rollups.get(key)
        if (!existing) {
          rollups.set(key, cloneRollup(row))
          continue
        }
        mergeRollup(existing, row)
      }
    },

    listRollups(from, to) {
      return Array.from(rollups.values())
        .filter((row) => row.bucketStart >= from && row.bucketStart <= to)
        .sort((a, b) => a.bucketStart - b.bucketStart)
        .map(cloneRollup)
    },

    insertError(error) {
      errors.push({ ...error, id: nextErrorId++ })
    },

    listErrors(from, to, limit) {
      return errors
        .filter((error) => error.createdAt >= from && error.createdAt <= to)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((error) => ({ ...error }))
    },
  }
}

type SqliteRollupRow = {
  bucket_start_ms: number
  bucket_size_ms: number
  run_started_count: number
  run_completed_count: number
  run_failed_count: number
  run_retried_count: number
  run_dead_letter_count: number
  run_resumed_count: number
  effect_completed_count: number
  effect_failed_count: number
  effect_replayed_count: number
  lease_reclaim_count: number
  internal_error_count: number
  run_duration_sum_ms: number
  run_duration_count: number
  run_duration_min_ms: number | null
  run_duration_max_ms: number | null
  run_dur_le_10ms: number
  run_dur_le_50ms: number
  run_dur_le_100ms: number
  run_dur_le_250ms: number
  run_dur_le_500ms: number
  run_dur_le_1000ms: number
  run_dur_le_2500ms: number
  run_dur_le_5000ms: number
  run_dur_le_10000ms: number
  run_dur_gt_10000ms: number
  effect_duration_sum_ms: number
  effect_duration_count: number
  effect_duration_min_ms: number | null
  effect_duration_max_ms: number | null
  effect_dur_le_10ms: number
  effect_dur_le_50ms: number
  effect_dur_le_100ms: number
  effect_dur_le_250ms: number
  effect_dur_le_500ms: number
  effect_dur_le_1000ms: number
  effect_dur_le_2500ms: number
  effect_dur_le_5000ms: number
  effect_dur_le_10000ms: number
  effect_dur_gt_10000ms: number
}

type SqliteErrorRow = {
  id: number
  kind: EngineObservabilityError['kind']
  created_at_ms: number
  process_name: string | null
  run_id: string | null
  effect_key: string | null
  context: string | null
  message: string
}

function rowToRollup(row: SqliteRollupRow): RollupRow {
  return {
    bucketStart: row.bucket_start_ms,
    bucketSizeMs: row.bucket_size_ms,
    runStartedCount: row.run_started_count,
    runCompletedCount: row.run_completed_count,
    runFailedCount: row.run_failed_count,
    runRetriedCount: row.run_retried_count,
    runDeadLetterCount: row.run_dead_letter_count,
    runResumedCount: row.run_resumed_count,
    effectCompletedCount: row.effect_completed_count,
    effectFailedCount: row.effect_failed_count,
    effectReplayedCount: row.effect_replayed_count,
    leaseReclaimCount: row.lease_reclaim_count,
    internalErrorCount: row.internal_error_count,
    runDurationSumMs: row.run_duration_sum_ms,
    runDurationCount: row.run_duration_count,
    runDurationMinMs: row.run_duration_min_ms,
    runDurationMaxMs: row.run_duration_max_ms,
    effectDurationSumMs: row.effect_duration_sum_ms,
    effectDurationCount: row.effect_duration_count,
    effectDurationMinMs: row.effect_duration_min_ms,
    effectDurationMaxMs: row.effect_duration_max_ms,
    runDurationHistogram: {
      le10ms: row.run_dur_le_10ms,
      le50ms: row.run_dur_le_50ms,
      le100ms: row.run_dur_le_100ms,
      le250ms: row.run_dur_le_250ms,
      le500ms: row.run_dur_le_500ms,
      le1000ms: row.run_dur_le_1000ms,
      le2500ms: row.run_dur_le_2500ms,
      le5000ms: row.run_dur_le_5000ms,
      le10000ms: row.run_dur_le_10000ms,
      gt10000ms: row.run_dur_gt_10000ms,
    },
    effectDurationHistogram: {
      le10ms: row.effect_dur_le_10ms,
      le50ms: row.effect_dur_le_50ms,
      le100ms: row.effect_dur_le_100ms,
      le250ms: row.effect_dur_le_250ms,
      le500ms: row.effect_dur_le_500ms,
      le1000ms: row.effect_dur_le_1000ms,
      le2500ms: row.effect_dur_le_2500ms,
      le5000ms: row.effect_dur_le_5000ms,
      le10000ms: row.effect_dur_le_10000ms,
      gt10000ms: row.effect_dur_gt_10000ms,
    },
  }
}

function errorRowToPublic(row: SqliteErrorRow): EngineObservabilityError {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at_ms,
    processName: row.process_name,
    runId: row.run_id,
    effectKey: row.effect_key,
    context: row.context,
    message: row.message,
  }
}

export function createSqliteEngineObservabilityStore(db: Database.Database): EngineObservabilityStore {
  const listRollupsStmt = db.prepare<[number, number], SqliteRollupRow>(`
    SELECT *
    FROM engine_observability_rollups
    WHERE bucket_start_ms >= ? AND bucket_start_ms <= ?
    ORDER BY bucket_start_ms ASC
  `)
  const insertErrorStmt = db.prepare<[EngineObservabilityError['kind'], number, string | null, string | null, string | null, string | null, string], unknown>(`
    INSERT INTO engine_observability_errors (kind, created_at_ms, process_name, run_id, effect_key, context, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const listErrorsStmt = db.prepare<[number, number, number], SqliteErrorRow>(`
    SELECT *
    FROM engine_observability_errors
    WHERE created_at_ms >= ? AND created_at_ms <= ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ?
  `)

  const upsertRollupStmt = db.prepare(`
    INSERT INTO engine_observability_rollups (
      bucket_start_ms,
      bucket_size_ms,
      run_started_count,
      run_completed_count,
      run_failed_count,
      run_retried_count,
      run_dead_letter_count,
      run_resumed_count,
      effect_completed_count,
      effect_failed_count,
      effect_replayed_count,
      lease_reclaim_count,
      internal_error_count,
      run_duration_sum_ms,
      run_duration_count,
      run_duration_min_ms,
      run_duration_max_ms,
      run_dur_le_10ms,
      run_dur_le_50ms,
      run_dur_le_100ms,
      run_dur_le_250ms,
      run_dur_le_500ms,
      run_dur_le_1000ms,
      run_dur_le_2500ms,
      run_dur_le_5000ms,
      run_dur_le_10000ms,
      run_dur_gt_10000ms,
      effect_duration_sum_ms,
      effect_duration_count,
      effect_duration_min_ms,
      effect_duration_max_ms,
      effect_dur_le_10ms,
      effect_dur_le_50ms,
      effect_dur_le_100ms,
      effect_dur_le_250ms,
      effect_dur_le_500ms,
      effect_dur_le_1000ms,
      effect_dur_le_2500ms,
      effect_dur_le_5000ms,
      effect_dur_le_10000ms,
      effect_dur_gt_10000ms
    ) VALUES (
      @bucket_start_ms,
      @bucket_size_ms,
      @run_started_count,
      @run_completed_count,
      @run_failed_count,
      @run_retried_count,
      @run_dead_letter_count,
      @run_resumed_count,
      @effect_completed_count,
      @effect_failed_count,
      @effect_replayed_count,
      @lease_reclaim_count,
      @internal_error_count,
      @run_duration_sum_ms,
      @run_duration_count,
      @run_duration_min_ms,
      @run_duration_max_ms,
      @run_dur_le_10ms,
      @run_dur_le_50ms,
      @run_dur_le_100ms,
      @run_dur_le_250ms,
      @run_dur_le_500ms,
      @run_dur_le_1000ms,
      @run_dur_le_2500ms,
      @run_dur_le_5000ms,
      @run_dur_le_10000ms,
      @run_dur_gt_10000ms,
      @effect_duration_sum_ms,
      @effect_duration_count,
      @effect_duration_min_ms,
      @effect_duration_max_ms,
      @effect_dur_le_10ms,
      @effect_dur_le_50ms,
      @effect_dur_le_100ms,
      @effect_dur_le_250ms,
      @effect_dur_le_500ms,
      @effect_dur_le_1000ms,
      @effect_dur_le_2500ms,
      @effect_dur_le_5000ms,
      @effect_dur_le_10000ms,
      @effect_dur_gt_10000ms
    )
    ON CONFLICT(bucket_start_ms, bucket_size_ms) DO UPDATE SET
      run_started_count = engine_observability_rollups.run_started_count + excluded.run_started_count,
      run_completed_count = engine_observability_rollups.run_completed_count + excluded.run_completed_count,
      run_failed_count = engine_observability_rollups.run_failed_count + excluded.run_failed_count,
      run_retried_count = engine_observability_rollups.run_retried_count + excluded.run_retried_count,
      run_dead_letter_count = engine_observability_rollups.run_dead_letter_count + excluded.run_dead_letter_count,
      run_resumed_count = engine_observability_rollups.run_resumed_count + excluded.run_resumed_count,
      effect_completed_count = engine_observability_rollups.effect_completed_count + excluded.effect_completed_count,
      effect_failed_count = engine_observability_rollups.effect_failed_count + excluded.effect_failed_count,
      effect_replayed_count = engine_observability_rollups.effect_replayed_count + excluded.effect_replayed_count,
      lease_reclaim_count = engine_observability_rollups.lease_reclaim_count + excluded.lease_reclaim_count,
      internal_error_count = engine_observability_rollups.internal_error_count + excluded.internal_error_count,
      run_duration_sum_ms = engine_observability_rollups.run_duration_sum_ms + excluded.run_duration_sum_ms,
      run_duration_count = engine_observability_rollups.run_duration_count + excluded.run_duration_count,
      run_duration_min_ms = CASE
        WHEN engine_observability_rollups.run_duration_min_ms IS NULL THEN excluded.run_duration_min_ms
        WHEN excluded.run_duration_min_ms IS NULL THEN engine_observability_rollups.run_duration_min_ms
        ELSE MIN(engine_observability_rollups.run_duration_min_ms, excluded.run_duration_min_ms)
      END,
      run_duration_max_ms = CASE
        WHEN engine_observability_rollups.run_duration_max_ms IS NULL THEN excluded.run_duration_max_ms
        WHEN excluded.run_duration_max_ms IS NULL THEN engine_observability_rollups.run_duration_max_ms
        ELSE MAX(engine_observability_rollups.run_duration_max_ms, excluded.run_duration_max_ms)
      END,
      run_dur_le_10ms = engine_observability_rollups.run_dur_le_10ms + excluded.run_dur_le_10ms,
      run_dur_le_50ms = engine_observability_rollups.run_dur_le_50ms + excluded.run_dur_le_50ms,
      run_dur_le_100ms = engine_observability_rollups.run_dur_le_100ms + excluded.run_dur_le_100ms,
      run_dur_le_250ms = engine_observability_rollups.run_dur_le_250ms + excluded.run_dur_le_250ms,
      run_dur_le_500ms = engine_observability_rollups.run_dur_le_500ms + excluded.run_dur_le_500ms,
      run_dur_le_1000ms = engine_observability_rollups.run_dur_le_1000ms + excluded.run_dur_le_1000ms,
      run_dur_le_2500ms = engine_observability_rollups.run_dur_le_2500ms + excluded.run_dur_le_2500ms,
      run_dur_le_5000ms = engine_observability_rollups.run_dur_le_5000ms + excluded.run_dur_le_5000ms,
      run_dur_le_10000ms = engine_observability_rollups.run_dur_le_10000ms + excluded.run_dur_le_10000ms,
      run_dur_gt_10000ms = engine_observability_rollups.run_dur_gt_10000ms + excluded.run_dur_gt_10000ms,
      effect_duration_sum_ms = engine_observability_rollups.effect_duration_sum_ms + excluded.effect_duration_sum_ms,
      effect_duration_count = engine_observability_rollups.effect_duration_count + excluded.effect_duration_count,
      effect_duration_min_ms = CASE
        WHEN engine_observability_rollups.effect_duration_min_ms IS NULL THEN excluded.effect_duration_min_ms
        WHEN excluded.effect_duration_min_ms IS NULL THEN engine_observability_rollups.effect_duration_min_ms
        ELSE MIN(engine_observability_rollups.effect_duration_min_ms, excluded.effect_duration_min_ms)
      END,
      effect_duration_max_ms = CASE
        WHEN engine_observability_rollups.effect_duration_max_ms IS NULL THEN excluded.effect_duration_max_ms
        WHEN excluded.effect_duration_max_ms IS NULL THEN engine_observability_rollups.effect_duration_max_ms
        ELSE MAX(engine_observability_rollups.effect_duration_max_ms, excluded.effect_duration_max_ms)
      END,
      effect_dur_le_10ms = engine_observability_rollups.effect_dur_le_10ms + excluded.effect_dur_le_10ms,
      effect_dur_le_50ms = engine_observability_rollups.effect_dur_le_50ms + excluded.effect_dur_le_50ms,
      effect_dur_le_100ms = engine_observability_rollups.effect_dur_le_100ms + excluded.effect_dur_le_100ms,
      effect_dur_le_250ms = engine_observability_rollups.effect_dur_le_250ms + excluded.effect_dur_le_250ms,
      effect_dur_le_500ms = engine_observability_rollups.effect_dur_le_500ms + excluded.effect_dur_le_500ms,
      effect_dur_le_1000ms = engine_observability_rollups.effect_dur_le_1000ms + excluded.effect_dur_le_1000ms,
      effect_dur_le_2500ms = engine_observability_rollups.effect_dur_le_2500ms + excluded.effect_dur_le_2500ms,
      effect_dur_le_5000ms = engine_observability_rollups.effect_dur_le_5000ms + excluded.effect_dur_le_5000ms,
      effect_dur_le_10000ms = engine_observability_rollups.effect_dur_le_10000ms + excluded.effect_dur_le_10000ms,
      effect_dur_gt_10000ms = engine_observability_rollups.effect_dur_gt_10000ms + excluded.effect_dur_gt_10000ms
  `)

  const upsertRollupsTx = db.transaction((rows: RollupRow[]) => {
    for (const row of rows) {
      upsertRollupStmt.run({
        bucket_start_ms: row.bucketStart,
        bucket_size_ms: row.bucketSizeMs,
        run_started_count: row.runStartedCount,
        run_completed_count: row.runCompletedCount,
        run_failed_count: row.runFailedCount,
        run_retried_count: row.runRetriedCount,
        run_dead_letter_count: row.runDeadLetterCount,
        run_resumed_count: row.runResumedCount,
        effect_completed_count: row.effectCompletedCount,
        effect_failed_count: row.effectFailedCount,
        effect_replayed_count: row.effectReplayedCount,
        lease_reclaim_count: row.leaseReclaimCount,
        internal_error_count: row.internalErrorCount,
        run_duration_sum_ms: row.runDurationSumMs,
        run_duration_count: row.runDurationCount,
        run_duration_min_ms: row.runDurationMinMs,
        run_duration_max_ms: row.runDurationMaxMs,
        run_dur_le_10ms: row.runDurationHistogram.le10ms,
        run_dur_le_50ms: row.runDurationHistogram.le50ms,
        run_dur_le_100ms: row.runDurationHistogram.le100ms,
        run_dur_le_250ms: row.runDurationHistogram.le250ms,
        run_dur_le_500ms: row.runDurationHistogram.le500ms,
        run_dur_le_1000ms: row.runDurationHistogram.le1000ms,
        run_dur_le_2500ms: row.runDurationHistogram.le2500ms,
        run_dur_le_5000ms: row.runDurationHistogram.le5000ms,
        run_dur_le_10000ms: row.runDurationHistogram.le10000ms,
        run_dur_gt_10000ms: row.runDurationHistogram.gt10000ms,
        effect_duration_sum_ms: row.effectDurationSumMs,
        effect_duration_count: row.effectDurationCount,
        effect_duration_min_ms: row.effectDurationMinMs,
        effect_duration_max_ms: row.effectDurationMaxMs,
        effect_dur_le_10ms: row.effectDurationHistogram.le10ms,
        effect_dur_le_50ms: row.effectDurationHistogram.le50ms,
        effect_dur_le_100ms: row.effectDurationHistogram.le100ms,
        effect_dur_le_250ms: row.effectDurationHistogram.le250ms,
        effect_dur_le_500ms: row.effectDurationHistogram.le500ms,
        effect_dur_le_1000ms: row.effectDurationHistogram.le1000ms,
        effect_dur_le_2500ms: row.effectDurationHistogram.le2500ms,
        effect_dur_le_5000ms: row.effectDurationHistogram.le5000ms,
        effect_dur_le_10000ms: row.effectDurationHistogram.le10000ms,
        effect_dur_gt_10000ms: row.effectDurationHistogram.gt10000ms,
      })
    }
  })

  return {
    upsertRollups(rows) {
      if (rows.length === 0) return
      upsertRollupsTx(rows)
    },

    listRollups(from, to) {
      return listRollupsStmt.all(from, to).map(rowToRollup)
    },

    insertError(error) {
      insertErrorStmt.run(error.kind, error.createdAt, error.processName, error.runId, error.effectKey, error.context, error.message)
    },

    listErrors(from, to, limit) {
      return listErrorsStmt.all(from, to, limit).map(errorRowToPublic)
    },
  }
}

export function createEngineObservabilityRecorder(opts: {
  store: EngineObservabilityStore
  lookupRun(runId: string): Run | null
  baseBucketMs?: number
  flushIntervalMs?: number
}) {
  const baseBucketMs = opts.baseBucketMs ?? ENGINE_OBSERVABILITY_BASE_BUCKET_MS
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const pending = new Map<number, RollupRow>()
  const flushTimer = setInterval(() => {
    flush()
  }, flushIntervalMs)
  flushTimer.unref?.()

  function ensurePending(timestamp: number): RollupRow {
    const bucketStart = bucketStartFor(timestamp, baseBucketMs)
    const existing = pending.get(bucketStart)
    if (existing) return existing
    const next = emptyRollup(bucketStart, baseBucketMs)
    pending.set(bucketStart, next)
    return next
  }

  function recordError(event: EngineEvent, timestamp: number): void {
    switch (event.type) {
      case 'run:error':
        opts.store.insertError({
          kind: 'run',
          createdAt: timestamp,
          processName: event.run.processName,
          runId: event.run.id,
          effectKey: null,
          context: null,
          message: event.error,
        })
        break
      case 'effect:error': {
        const run = opts.lookupRun(event.runId)
        opts.store.insertError({
          kind: 'effect',
          createdAt: timestamp,
          processName: run?.processName ?? null,
          runId: event.runId,
          effectKey: event.effectKey,
          context: null,
          message: event.error,
        })
        break
      }
      case 'internal:error':
        opts.store.insertError({
          kind: 'internal',
          createdAt: timestamp,
          processName: null,
          runId: null,
          effectKey: null,
          context: event.context,
          message: stringifyError(event.error),
        })
        break
    }
  }

  function record(event: EngineEvent): void {
    const timestamp = Date.now()
    const row = ensurePending(timestamp)

    switch (event.type) {
      case 'run:start':
        row.runStartedCount++
        break
      case 'run:complete':
        row.runCompletedCount++
        addRunDuration(row, event.durationMs)
        break
      case 'run:error':
        row.runFailedCount++
        addRunDuration(row, event.durationMs)
        recordError(event, timestamp)
        break
      case 'run:retry':
        row.runRetriedCount++
        break
      case 'run:dead':
        row.runDeadLetterCount++
        break
      case 'run:resume':
        row.runResumedCount++
        break
      case 'effect:complete':
        row.effectCompletedCount++
        addEffectDuration(row, event.durationMs)
        break
      case 'effect:error':
        row.effectFailedCount++
        addEffectDuration(row, event.durationMs)
        recordError(event, timestamp)
        break
      case 'effect:replay':
        row.effectReplayedCount++
        break
      case 'lease:reclaim':
        row.leaseReclaimCount++
        break
      case 'internal:error':
        row.internalErrorCount++
        recordError(event, timestamp)
        break
    }
  }

  function flush(): void {
    if (pending.size === 0) return
    const rows = Array.from(pending.values()).map(cloneRollup)
    pending.clear()
    opts.store.upsertRollups(rows)
  }

  function getObservability(query: EngineObservabilityQuery = {}): EngineObservabilityReport {
    const to = query.to ?? Date.now()
    const from = query.from ?? Math.max(0, to - DEFAULT_OBSERVABILITY_WINDOW_MS)
    const bucketSizeMs = query.bucketMs ?? baseBucketMs
    const errorLimit = query.errorLimit ?? DEFAULT_ERROR_LIMIT

    const baseRows = new Map<number, RollupRow>()
    for (const row of opts.store.listRollups(bucketStartFor(from, baseBucketMs), bucketStartFor(to, baseBucketMs))) {
      baseRows.set(row.bucketStart, row)
    }
    for (const row of pending.values()) {
      const existing = baseRows.get(row.bucketStart)
      if (!existing) {
        baseRows.set(row.bucketStart, cloneRollup(row))
        continue
      }
      mergeRollup(existing, row)
    }

    const rebucketed = new Map<number, RollupRow>()
    for (const row of Array.from(baseRows.values()).sort((a, b) => a.bucketStart - b.bucketStart)) {
      if (row.bucketStart < bucketStartFor(from, baseBucketMs) || row.bucketStart > bucketStartFor(to, baseBucketMs)) continue
      const nextBucketStart = bucketStartFor(row.bucketStart, bucketSizeMs)
      const existing = rebucketed.get(nextBucketStart)
      if (!existing) {
        const next = emptyRollup(nextBucketStart, bucketSizeMs)
        mergeRollup(next, row)
        rebucketed.set(nextBucketStart, next)
        continue
      }
      mergeRollup(existing, row)
    }

    const buckets = Array.from(rebucketed.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map(toPublicBucket)
    const recentErrors = opts.store.listErrors(from, to, errorLimit)

    return {
      from,
      to,
      bucketSizeMs,
      summary: summarizeBuckets(buckets, recentErrors.length),
      buckets,
      recentErrors,
    }
  }

  function close(): void {
    clearInterval(flushTimer)
    flush()
  }

  return {
    record,
    flush,
    close,
    getObservability,
  }
}
