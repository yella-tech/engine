import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteEngineObservabilityStore } from './observability-store.js'
import { isDeferredRun } from './status.js'
import type { EffectRecord, EffectStore, HandlerResult, ProcessState, Run, RunCreateRequest, RunQueryOptions, RunSortOrder, RunStatus, RunStore, TimelineEntry } from './types.js'
import { VALID_TRANSITIONS } from './types.js'

type RunRow = {
  id: string
  correlation_id: string
  process_name: string
  event_name: string
  state: string
  context: string
  payload: string | null
  result: string | null
  timeline: string
  parent_run_id: string | null
  child_run_ids: string
  started_at: number
  completed_at: number | null
  depth: number
  idempotency_key: string | null
  attempt: number
  retry_after: number | null
  lease_owner: string | null
  lease_expires_at: number | null
  heartbeat_at: number | null
  handler_version: string | null
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    processName: row.process_name,
    eventName: row.event_name,
    state: row.state as ProcessState,
    context: JSON.parse(row.context),
    payload: row.payload ? JSON.parse(row.payload) : null,
    result: row.result ? JSON.parse(row.result) : null,
    timeline: JSON.parse(row.timeline),
    parentRunId: row.parent_run_id,
    childRunIds: JSON.parse(row.child_run_ids),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    depth: row.depth,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    retryAfter: row.retry_after,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    handlerVersion: row.handler_version,
  }
}

class DuplicateEmissionReservationError extends Error {
  constructor() {
    super('duplicate emission reservation')
  }
}

const migrations: ((db: Database.Database) => void)[] = [
  // Migration 0 → 1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        correlation_id  TEXT NOT NULL,
        process_name    TEXT NOT NULL,
        event_name      TEXT NOT NULL,
        state           TEXT NOT NULL CHECK(state IN ('idle','running','completed','errored')),
        context         TEXT NOT NULL DEFAULT '{}',
        payload         TEXT,
        result          TEXT,
        timeline        TEXT NOT NULL DEFAULT '[]',
        parent_run_id   TEXT,
        child_run_ids   TEXT NOT NULL DEFAULT '[]',
        started_at      INTEGER NOT NULL,
        completed_at    INTEGER
      );
      CREATE INDEX idx_runs_state ON runs(state);
      CREATE INDEX idx_runs_correlation_id ON runs(correlation_id);
      CREATE INDEX idx_runs_process_name ON runs(process_name);
      CREATE INDEX idx_runs_parent_run_id ON runs(parent_run_id);
    `)
  },
  // Migration 1 → 2: depth, idempotency key
  (db) => {
    db.exec(`
      ALTER TABLE runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN idempotency_key TEXT;
      CREATE INDEX idx_runs_idempotency_key ON runs(idempotency_key);
    `)
  },
  // Migration 2 → 3: unique idempotency per process (composite index)
  (db) => {
    db.exec(`
      DROP INDEX idx_runs_idempotency_key;
      CREATE UNIQUE INDEX idx_runs_idempotency_key ON runs(idempotency_key, process_name)
        WHERE idempotency_key IS NOT NULL;
    `)
  },
  // Migration 3 → 4: retry support (attempt counter + retry_after)
  (db) => {
    db.exec(`
      ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN retry_after INTEGER;
    `)
  },
  // Migration 4 → 5: lease-based crash recovery
  (db) => {
    db.exec(`
      ALTER TABLE runs ADD COLUMN lease_owner TEXT;
      ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
      ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
      CREATE INDEX idx_runs_lease_expires_at ON runs(lease_expires_at);
    `)
  },
  // Migration 5 → 6: effect ledger
  (db) => {
    db.exec(`
      CREATE TABLE run_effects (
        run_id        TEXT NOT NULL,
        effect_key    TEXT NOT NULL,
        state         TEXT NOT NULL CHECK(state IN ('started','completed','failed')),
        output        TEXT,
        error         TEXT,
        started_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        PRIMARY KEY (run_id, effect_key)
      );
    `)
  },
  // Migration 6 → 7: handler version metadata
  (db) => {
    db.exec(`
      ALTER TABLE runs ADD COLUMN handler_version TEXT;
    `)
  },
  // Migration 7 → 8: composite index for efficient state+time queries
  (db) => {
    db.exec(`
      CREATE INDEX idx_runs_state_started_at ON runs(state, started_at DESC);
    `)
  },
  // Migration 8 → 9: engine observability rollups and recent errors
  (db) => {
    db.exec(`
      CREATE TABLE engine_observability_rollups (
        bucket_start_ms           INTEGER NOT NULL,
        bucket_size_ms            INTEGER NOT NULL,
        run_started_count         INTEGER NOT NULL DEFAULT 0,
        run_completed_count       INTEGER NOT NULL DEFAULT 0,
        run_failed_count          INTEGER NOT NULL DEFAULT 0,
        run_retried_count         INTEGER NOT NULL DEFAULT 0,
        run_dead_letter_count     INTEGER NOT NULL DEFAULT 0,
        run_resumed_count         INTEGER NOT NULL DEFAULT 0,
        effect_completed_count    INTEGER NOT NULL DEFAULT 0,
        effect_failed_count       INTEGER NOT NULL DEFAULT 0,
        effect_replayed_count     INTEGER NOT NULL DEFAULT 0,
        lease_reclaim_count       INTEGER NOT NULL DEFAULT 0,
        internal_error_count      INTEGER NOT NULL DEFAULT 0,
        run_duration_sum_ms       INTEGER NOT NULL DEFAULT 0,
        run_duration_count        INTEGER NOT NULL DEFAULT 0,
        run_duration_min_ms       INTEGER,
        run_duration_max_ms       INTEGER,
        run_dur_le_10ms           INTEGER NOT NULL DEFAULT 0,
        run_dur_le_50ms           INTEGER NOT NULL DEFAULT 0,
        run_dur_le_100ms          INTEGER NOT NULL DEFAULT 0,
        run_dur_le_250ms          INTEGER NOT NULL DEFAULT 0,
        run_dur_le_500ms          INTEGER NOT NULL DEFAULT 0,
        run_dur_le_1000ms         INTEGER NOT NULL DEFAULT 0,
        run_dur_le_2500ms         INTEGER NOT NULL DEFAULT 0,
        run_dur_le_5000ms         INTEGER NOT NULL DEFAULT 0,
        run_dur_le_10000ms        INTEGER NOT NULL DEFAULT 0,
        run_dur_gt_10000ms        INTEGER NOT NULL DEFAULT 0,
        effect_duration_sum_ms    INTEGER NOT NULL DEFAULT 0,
        effect_duration_count     INTEGER NOT NULL DEFAULT 0,
        effect_duration_min_ms    INTEGER,
        effect_duration_max_ms    INTEGER,
        effect_dur_le_10ms        INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_50ms        INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_100ms       INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_250ms       INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_500ms       INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_1000ms      INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_2500ms      INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_5000ms      INTEGER NOT NULL DEFAULT 0,
        effect_dur_le_10000ms     INTEGER NOT NULL DEFAULT 0,
        effect_dur_gt_10000ms     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_start_ms, bucket_size_ms)
      );

      CREATE TABLE engine_observability_errors (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        kind             TEXT NOT NULL CHECK(kind IN ('run','effect','internal')),
        created_at_ms    INTEGER NOT NULL,
        process_name     TEXT,
        run_id           TEXT,
        effect_key       TEXT,
        context          TEXT,
        message          TEXT NOT NULL
      );

      CREATE INDEX idx_engine_observability_rollups_bucket_start ON engine_observability_rollups(bucket_start_ms DESC);
      CREATE INDEX idx_engine_observability_errors_created_at ON engine_observability_errors(created_at_ms DESC);
    `)
  },
  // Migration 9 → 10: atomic emission reservations and singleton claims
  (db) => {
    db.exec(`
      CREATE TABLE run_emissions (
        event_name        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        PRIMARY KEY (event_name, idempotency_key)
      );

      CREATE TABLE run_singleton_meta (
        run_id            TEXT PRIMARY KEY,
        process_name      TEXT NOT NULL
      );

      CREATE TABLE active_singletons (
        process_name      TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL UNIQUE
      );
    `)
    db.exec(`
      INSERT INTO run_emissions (event_name, idempotency_key, created_at)
      SELECT event_name, idempotency_key, MIN(started_at)
      FROM runs
      WHERE idempotency_key IS NOT NULL
      GROUP BY event_name, idempotency_key;
    `)
  },
]

function applyMigrations(db: Database.Database) {
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  for (let i = currentVersion; i < migrations.length; i++) {
    migrations[i](db)
  }
  if (currentVersion < migrations.length) {
    db.pragma(`user_version = ${migrations.length}`)
  }
}

const DEFERRED_MARKER_PREDICATE = ["coalesce(CAST(json_extract(result, '$.deferred') AS INTEGER), 0) = 1", "coalesce(json_type(result, '$.triggerEvent'), '') = 'text'"].join(' AND ')

const DEAD_LETTER_MARKER_PREDICATE = "coalesce(json_extract(timeline, '$[' || (json_array_length(timeline) - 1) || '].event'), '') = 'dead-letter'"

function buildStatusQuery(where: string, order: RunSortOrder, root = false): string {
  const rootClause = root ? ' AND parent_run_id IS NULL' : ''
  return `SELECT * FROM runs WHERE ${where}${rootClause} ORDER BY started_at ${order.toUpperCase()} LIMIT ? OFFSET ?`
}

function buildStatusCountQuery(where: string, root = false): string {
  const rootClause = root ? ' AND parent_run_id IS NULL' : ''
  return `SELECT COUNT(*) as cnt FROM runs WHERE ${where}${rootClause}`
}

function createSqliteRunStoreFromDb(db: Database.Database): RunStore {
  // Prepared statements
  const stmts = {
    insert: db.prepare(`
      INSERT INTO runs (id, correlation_id, process_name, event_name, state, context, payload, result, timeline, parent_run_id, child_run_ids, started_at, completed_at, depth, idempotency_key, attempt, retry_after, lease_owner, lease_expires_at, heartbeat_at, handler_version)
      VALUES (@id, @correlation_id, @process_name, @event_name, @state, @context, @payload, @result, @timeline, @parent_run_id, @child_run_ids, @started_at, @completed_at, @depth, @idempotency_key, @attempt, @retry_after, @lease_owner, @lease_expires_at, @heartbeat_at, @handler_version)
    `),
    getById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    updateState: db.prepare('UPDATE runs SET state = ?, timeline = ?, completed_at = ?, result = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ?'),
    updateResult: db.prepare('UPDATE runs SET result = ? WHERE id = ?'),
    updateContext: db.prepare('UPDATE runs SET context = ? WHERE id = ?'),
    updateChildRunIds: db.prepare('UPDATE runs SET child_run_ids = ? WHERE id = ?'),
    reserveEmission: db.prepare(`
      INSERT INTO run_emissions (event_name, idempotency_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(event_name, idempotency_key) DO NOTHING
    `),
    insertSingletonMeta: db.prepare('INSERT INTO run_singleton_meta (run_id, process_name) VALUES (?, ?)'),
    claimSingleton: db.prepare(`
      INSERT INTO active_singletons (process_name, run_id)
      VALUES (?, ?)
      ON CONFLICT(process_name) DO NOTHING
    `),
    getSingletonProcessByRunId: db.prepare('SELECT process_name FROM run_singleton_meta WHERE run_id = ?'),
    releaseSingletonByRunId: db.prepare('DELETE FROM active_singletons WHERE run_id = ?'),
    deleteSingletonMetaByRunId: db.prepare('DELETE FROM run_singleton_meta WHERE run_id = ?'),
    getByProcess: db.prepare('SELECT * FROM runs WHERE process_name = ?'),
    getByState: db.prepare('SELECT * FROM runs WHERE state = ?'),
    getAll: db.prepare('SELECT * FROM runs'),
    claimIdle: db.prepare('SELECT * FROM runs WHERE state = ? AND (retry_after IS NULL OR retry_after <= ?) ORDER BY started_at LIMIT ?'),
    prepareRetry: db.prepare('UPDATE runs SET attempt = attempt + 1, retry_after = ? WHERE id = ?'),
    resetAttempt: db.prepare('UPDATE runs SET attempt = 0, retry_after = NULL WHERE id = ?'),
    claimUpdate: db.prepare(
      "UPDATE runs SET state = ?, timeline = ?, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ? WHERE id = ? AND state = 'idle' AND (retry_after IS NULL OR retry_after <= ?)",
    ),
    getChildren: db.prepare('SELECT * FROM runs WHERE parent_run_id = ?'),
    hasActiveRun: db.prepare("SELECT 1 FROM runs WHERE process_name = ? AND state IN ('idle', 'running') LIMIT 1"),
    hasIdempotencyKey: db.prepare('SELECT 1 FROM runs WHERE idempotency_key = ? LIMIT 1'),
    getByIdempotencyKey: db.prepare('SELECT * FROM runs WHERE idempotency_key = ?'),
    heartbeat: db.prepare("UPDATE runs SET lease_expires_at = ?, heartbeat_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running'"),
    reclaimStaleSelect: db.prepare("SELECT * FROM runs WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"),
    reclaimStaleUpdate: db.prepare("UPDATE runs SET state = 'idle', attempt = attempt + 1, timeline = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ?"),
    setHandlerVersion: db.prepare('UPDATE runs SET handler_version = ? WHERE id = ?'),
    countByState: db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE state = ?'),
    hasState: db.prepare('SELECT 1 FROM runs WHERE state = ? LIMIT 1'),
    paginatedByStateDesc: db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    paginatedByStateAsc: db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY started_at ASC LIMIT ? OFFSET ?'),
    paginatedAllDesc: db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    paginatedAllAsc: db.prepare('SELECT * FROM runs ORDER BY started_at ASC LIMIT ? OFFSET ?'),
    countAll: db.prepare('SELECT COUNT(*) as cnt FROM runs'),
    paginatedByStateRootDesc: db.prepare('SELECT * FROM runs WHERE state = ? AND parent_run_id IS NULL ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    paginatedByStateRootAsc: db.prepare('SELECT * FROM runs WHERE state = ? AND parent_run_id IS NULL ORDER BY started_at ASC LIMIT ? OFFSET ?'),
    paginatedAllRootDesc: db.prepare('SELECT * FROM runs WHERE parent_run_id IS NULL ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    paginatedAllRootAsc: db.prepare('SELECT * FROM runs WHERE parent_run_id IS NULL ORDER BY started_at ASC LIMIT ? OFFSET ?'),
    countByStateRoot: db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE state = ? AND parent_run_id IS NULL'),
    countAllRoot: db.prepare('SELECT COUNT(*) as cnt FROM runs WHERE parent_run_id IS NULL'),
    paginatedCompletedStatusDesc: db.prepare(buildStatusQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`, 'desc')),
    paginatedCompletedStatusAsc: db.prepare(buildStatusQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`, 'asc')),
    paginatedCompletedStatusRootDesc: db.prepare(buildStatusQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`, 'desc', true)),
    paginatedCompletedStatusRootAsc: db.prepare(buildStatusQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`, 'asc', true)),
    countCompletedStatus: db.prepare(buildStatusCountQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`)),
    countCompletedStatusRoot: db.prepare(buildStatusCountQuery(`state = 'completed' AND NOT (${DEFERRED_MARKER_PREDICATE})`, true)),
    paginatedDeferredStatusDesc: db.prepare(buildStatusQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`, 'desc')),
    paginatedDeferredStatusAsc: db.prepare(buildStatusQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`, 'asc')),
    paginatedDeferredStatusRootDesc: db.prepare(buildStatusQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`, 'desc', true)),
    paginatedDeferredStatusRootAsc: db.prepare(buildStatusQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`, 'asc', true)),
    countDeferredStatus: db.prepare(buildStatusCountQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`)),
    countDeferredStatusRoot: db.prepare(buildStatusCountQuery(`state = 'completed' AND ${DEFERRED_MARKER_PREDICATE}`, true)),
    paginatedErroredStatusDesc: db.prepare(buildStatusQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`, 'desc')),
    paginatedErroredStatusAsc: db.prepare(buildStatusQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`, 'asc')),
    paginatedErroredStatusRootDesc: db.prepare(buildStatusQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`, 'desc', true)),
    paginatedErroredStatusRootAsc: db.prepare(buildStatusQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`, 'asc', true)),
    countErroredStatus: db.prepare(buildStatusCountQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`)),
    countErroredStatusRoot: db.prepare(buildStatusCountQuery(`state = 'errored' AND NOT (${DEAD_LETTER_MARKER_PREDICATE})`, true)),
    paginatedDeadLetterStatusDesc: db.prepare(buildStatusQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`, 'desc')),
    paginatedDeadLetterStatusAsc: db.prepare(buildStatusQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`, 'asc')),
    paginatedDeadLetterStatusRootDesc: db.prepare(buildStatusQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`, 'desc', true)),
    paginatedDeadLetterStatusRootAsc: db.prepare(buildStatusQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`, 'asc', true)),
    countDeadLetterStatus: db.prepare(buildStatusCountQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`)),
    countDeadLetterStatusRoot: db.prepare(buildStatusCountQuery(`state = 'errored' AND ${DEAD_LETTER_MARKER_PREDICATE}`, true)),
    pruneCompletedCandidates: db.prepare("SELECT * FROM runs WHERE state = 'completed' AND completed_at IS NOT NULL AND completed_at < ?"),
    clearParentRunIds: db.prepare('UPDATE runs SET parent_run_id = NULL WHERE parent_run_id = ?'),
    deleteById: db.prepare('DELETE FROM runs WHERE id = ?'),
  }

  function syncSingletonForStateChange(runId: string, currentState: ProcessState, nextState: ProcessState): void {
    const singletonRow = stmts.getSingletonProcessByRunId.get(runId) as { process_name: string } | undefined
    if (!singletonRow) return

    const wasActive = currentState === 'idle' || currentState === 'running'
    const willBeActive = nextState === 'idle' || nextState === 'running'

    if (!wasActive && willBeActive) {
      const claim = stmts.claimSingleton.run(singletonRow.process_name, runId)
      if (claim.changes === 0) {
        throw new Error(`Singleton already active: ${singletonRow.process_name}`)
      }
      return
    }

    if (wasActive && !willBeActive) {
      stmts.releaseSingletonByRunId.run(runId)
    }
  }

  function createStoredRun(id: string, request: RunCreateRequest): Run {
    const now = Date.now()
    const timeline: TimelineEntry[] = [{ state: 'idle', timestamp: now, event: request.eventName, payload: request.payload }]

    const run: Run = {
      id,
      correlationId: request.correlationId ?? id,
      processName: request.processName,
      eventName: request.eventName,
      state: 'idle',
      context: request.context ? { ...request.context } : {},
      payload: request.payload,
      result: null,
      timeline,
      parentRunId: request.parentRunId ?? null,
      childRunIds: [],
      startedAt: now,
      completedAt: null,
      depth: request.depth ?? 0,
      idempotencyKey: request.idempotencyKey ?? null,
      attempt: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      handlerVersion: null,
    }

    stmts.insert.run({
      id: run.id,
      correlation_id: run.correlationId,
      process_name: run.processName,
      event_name: run.eventName,
      state: run.state,
      context: JSON.stringify(run.context),
      payload: JSON.stringify(run.payload),
      result: null,
      timeline: JSON.stringify(run.timeline),
      parent_run_id: run.parentRunId,
      child_run_ids: JSON.stringify(run.childRunIds),
      started_at: run.startedAt,
      completed_at: null,
      depth: run.depth,
      idempotency_key: run.idempotencyKey,
      attempt: 0,
      retry_after: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      handler_version: null,
    })

    if (request.parentRunId) {
      const parentRow = stmts.getById.get(request.parentRunId) as RunRow | undefined
      if (parentRow) {
        const childIds: string[] = JSON.parse(parentRow.child_run_ids)
        childIds.push(id)
        stmts.updateChildRunIds.run(JSON.stringify(childIds), request.parentRunId)
      }
    }

    return run
  }

  function create(
    processName: string,
    eventName: string,
    payload: unknown,
    parentRunId?: string | null,
    correlationId?: string,
    context?: Record<string, unknown>,
    depth?: number,
    idempotencyKey?: string | null,
  ): Run {
    return createStoredRun(crypto.randomUUID(), {
      processName,
      eventName,
      payload,
      parentRunId,
      correlationId,
      context,
      depth,
      idempotencyKey,
    })
  }

  function createMany(requests: RunCreateRequest[]): Run[] {
    if (requests.length === 0) return []

    const createManyTransaction = db.transaction((batch: RunCreateRequest[]) => {
      const creatable: Array<{ id: string; request: RunCreateRequest }> = []

      for (const request of batch) {
        const id = crypto.randomUUID()
        if (request.singleton) {
          if (stmts.hasActiveRun.get(request.processName) !== undefined) continue
          const claim = stmts.claimSingleton.run(request.processName, id)
          if (claim.changes === 0) continue
          stmts.insertSingletonMeta.run(id, request.processName)
        }
        creatable.push({ id, request })
      }

      if (creatable.length === 0) return []

      const eventName = batch[0].eventName
      const idempotencyKey = batch[0].idempotencyKey ?? null
      if (idempotencyKey) {
        const reservation = stmts.reserveEmission.run(eventName, idempotencyKey, Date.now())
        if (reservation.changes === 0) {
          throw new DuplicateEmissionReservationError()
        }
      }

      const runs: Run[] = []
      for (const { id, request } of creatable) {
        runs.push(createStoredRun(id, request))
      }

      return runs
    })

    try {
      return createManyTransaction(requests)
    } catch (err) {
      if (err instanceof DuplicateEmissionReservationError) {
        return []
      }
      throw err
    }
  }

  function transition(runId: string, state: ProcessState, meta?: { error?: string; event?: string; payload?: unknown }): Run {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)

    const currentState = row.state as ProcessState
    const allowed = VALID_TRANSITIONS[currentState]
    if (!allowed.includes(state)) {
      throw new Error(`Invalid transition: ${currentState} → ${state}`)
    }

    syncSingletonForStateChange(runId, currentState, state)
    const timeline: TimelineEntry[] = JSON.parse(row.timeline)
    const entry: TimelineEntry = { state, timestamp: Date.now() }
    if (meta?.error) entry.error = meta.error
    if (meta?.event) entry.event = meta.event
    if (meta?.payload !== undefined) entry.payload = meta.payload
    timeline.push(entry)

    const completedAt = state === 'completed' || state === 'errored' ? Date.now() : null
    const result = state === 'idle' || state === 'running' ? null : row.result

    stmts.updateState.run(state, JSON.stringify(timeline), completedAt, result, runId)

    return rowToRun({
      ...row,
      state,
      timeline: JSON.stringify(timeline),
      result,
      completed_at: completedAt,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    })
  }

  function setResult(runId: string, result: HandlerResult): void {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)
    stmts.updateResult.run(JSON.stringify(result), runId)
  }

  function updateContext(runId: string, key: string, value: unknown): void {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)
    const ctx = JSON.parse(row.context)
    ctx[key] = value
    stmts.updateContext.run(JSON.stringify(ctx), runId)
  }

  function prepareRetry(runId: string, retryAfter: number): void {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)
    stmts.prepareRetry.run(retryAfter, runId)
  }

  function resetAttempt(runId: string): void {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)
    stmts.resetAttempt.run(runId)
  }

  function claimIdle(limit: number, leaseOwner?: string, leaseDurationMs?: number): Run[] {
    const claimTransaction = db.transaction(() => {
      const now = Date.now()
      const rows = stmts.claimIdle.all('idle', now, limit) as RunRow[]
      const runs: Run[] = []

      const lo = leaseOwner && leaseDurationMs ? leaseOwner : null
      const leaseExp = leaseOwner && leaseDurationMs ? now + leaseDurationMs : null
      const hb = leaseOwner && leaseDurationMs ? now : null

      for (const row of rows) {
        const timeline: TimelineEntry[] = JSON.parse(row.timeline)
        timeline.push({ state: 'running', timestamp: now })
        const claim = stmts.claimUpdate.run('running', JSON.stringify(timeline), lo, leaseExp, hb, row.id, now)
        if (claim.changes === 0) continue
        runs.push(
          rowToRun({
            ...row,
            state: 'running',
            timeline: JSON.stringify(timeline),
            lease_owner: lo,
            lease_expires_at: leaseExp,
            heartbeat_at: hb,
          }),
        )
      }

      return runs
    })

    return claimTransaction()
  }

  function get(runId: string): Run | null {
    const row = stmts.getById.get(runId) as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  function getByProcess(processName: string): Run[] {
    const rows = stmts.getByProcess.all(processName) as RunRow[]
    return rows.map(rowToRun)
  }

  function getByState(state: ProcessState): Run[] {
    const rows = stmts.getByState.all(state) as RunRow[]
    return rows.map(rowToRun)
  }

  function getAll(): Run[] {
    const rows = stmts.getAll.all() as RunRow[]
    return rows.map(rowToRun)
  }

  function getChain(runId: string): Run[] {
    const rootRow = stmts.getById.get(runId) as RunRow | undefined
    if (!rootRow) return []

    const chain: Run[] = []
    const queue = [rootRow]

    while (queue.length > 0) {
      const current = queue.shift()!
      chain.push(rowToRun(current))
      const children = stmts.getChildren.all(current.id) as RunRow[]
      queue.push(...children)
    }

    return chain
  }

  function hasActiveRun(processName: string): boolean {
    return stmts.hasActiveRun.get(processName) !== undefined
  }

  function hasIdempotencyKey(key: string): boolean {
    return stmts.hasIdempotencyKey.get(key) !== undefined
  }

  function getByIdempotencyKey(key: string): Run[] {
    const rows = stmts.getByIdempotencyKey.all(key) as RunRow[]
    return rows.map(rowToRun)
  }

  function setHandlerVersion(runId: string, version: string): void {
    stmts.setHandlerVersion.run(version, runId)
  }

  function countByState(state: ProcessState): number {
    return (stmts.countByState.get(state) as { cnt: number }).cnt
  }

  function hasState(state: ProcessState): boolean {
    return stmts.hasState.get(state) !== undefined
  }

  function getStatePageStatement(state: ProcessState | null, order: RunSortOrder, root: boolean) {
    if (state && root) return order === 'asc' ? stmts.paginatedByStateRootAsc : stmts.paginatedByStateRootDesc
    if (state) return order === 'asc' ? stmts.paginatedByStateAsc : stmts.paginatedByStateDesc
    if (root) return order === 'asc' ? stmts.paginatedAllRootAsc : stmts.paginatedAllRootDesc
    return order === 'asc' ? stmts.paginatedAllAsc : stmts.paginatedAllDesc
  }

  function getStatusStatements(status: RunStatus, order: RunSortOrder, root: boolean) {
    switch (status) {
      case 'completed':
        return {
          page: root
            ? order === 'asc'
              ? stmts.paginatedCompletedStatusRootAsc
              : stmts.paginatedCompletedStatusRootDesc
            : order === 'asc'
              ? stmts.paginatedCompletedStatusAsc
              : stmts.paginatedCompletedStatusDesc,
          count: root ? stmts.countCompletedStatusRoot : stmts.countCompletedStatus,
        }
      case 'deferred':
        return {
          page: root
            ? order === 'asc'
              ? stmts.paginatedDeferredStatusRootAsc
              : stmts.paginatedDeferredStatusRootDesc
            : order === 'asc'
              ? stmts.paginatedDeferredStatusAsc
              : stmts.paginatedDeferredStatusDesc,
          count: root ? stmts.countDeferredStatusRoot : stmts.countDeferredStatus,
        }
      case 'errored':
        return {
          page: root
            ? order === 'asc'
              ? stmts.paginatedErroredStatusRootAsc
              : stmts.paginatedErroredStatusRootDesc
            : order === 'asc'
              ? stmts.paginatedErroredStatusAsc
              : stmts.paginatedErroredStatusDesc,
          count: root ? stmts.countErroredStatusRoot : stmts.countErroredStatus,
        }
      case 'dead-letter':
        return {
          page: root
            ? order === 'asc'
              ? stmts.paginatedDeadLetterStatusRootAsc
              : stmts.paginatedDeadLetterStatusRootDesc
            : order === 'asc'
              ? stmts.paginatedDeadLetterStatusAsc
              : stmts.paginatedDeadLetterStatusDesc,
          count: root ? stmts.countDeadLetterStatusRoot : stmts.countDeadLetterStatus,
        }
    }

    throw new Error(`Unsupported status query: ${status}`)
  }

  function getByStatePaginated(state: ProcessState | null, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    const root = opts?.root ?? false
    const order = opts?.order ?? 'desc'
    const pageStmt = getStatePageStatement(state, order, root)

    if (state) {
      const rows = pageStmt.all(state, limit, offset) as RunRow[]
      const totalRow = root ? (stmts.countByStateRoot.get(state) as { cnt: number }) : (stmts.countByState.get(state) as { cnt: number })
      const total = totalRow.cnt
      return { runs: rows.map(rowToRun), total }
    } else {
      const rows = pageStmt.all(limit, offset) as RunRow[]
      const totalRow = root ? (stmts.countAllRoot.get() as { cnt: number }) : (stmts.countAll.get() as { cnt: number })
      const total = totalRow.cnt
      return { runs: rows.map(rowToRun), total }
    }
  }

  function getByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    if (status === 'idle' || status === 'running') {
      return getByStatePaginated(status, limit, offset, opts)
    }

    const root = opts?.root ?? false
    const order = opts?.order ?? 'desc'
    const statements = getStatusStatements(status, order, root)
    const rows = statements.page.all(limit, offset) as RunRow[]
    const totalRow = statements.count.get() as { cnt: number }

    return { runs: rows.map(rowToRun), total: totalRow.cnt }
  }

  function pruneCompletedBefore(cutoffMs: number): string[] {
    const pruneTransaction = db.transaction(() => {
      const candidateRows = stmts.pruneCompletedCandidates.all(cutoffMs) as RunRow[]
      const candidates = candidateRows.map(rowToRun).filter((run) => !isDeferredRun(run))
      if (candidates.length === 0) return []

      const candidateById = new Map(candidates.map((run) => [run.id, run]))
      const prunedIds = new Set(candidateById.keys())
      let changed = true
      while (changed) {
        changed = false
        for (const id of Array.from(prunedIds)) {
          const run = candidateById.get(id)
          if (!run) {
            prunedIds.delete(id)
            changed = true
            continue
          }
          if (run.childRunIds.some((childId) => !prunedIds.has(childId))) {
            prunedIds.delete(id)
            changed = true
          }
        }
      }

      if (prunedIds.size === 0) return []

      const impactedParentIds = new Set(
        Array.from(prunedIds)
          .map((id) => candidateById.get(id)?.parentRunId ?? null)
          .filter((id): id is string => id !== null),
      )

      for (const parentId of impactedParentIds) {
        const parentRow = stmts.getById.get(parentId) as RunRow | undefined
        if (!parentRow) continue
        const nextChildIds = (JSON.parse(parentRow.child_run_ids) as string[]).filter((childId) => !prunedIds.has(childId))
        stmts.updateChildRunIds.run(JSON.stringify(nextChildIds), parentId)
      }

      for (const runId of prunedIds) {
        stmts.releaseSingletonByRunId.run(runId)
        stmts.deleteSingletonMetaByRunId.run(runId)
        stmts.clearParentRunIds.run(runId)
        stmts.deleteById.run(runId)
      }

      return Array.from(prunedIds)
    })

    return pruneTransaction()
  }

  function close() {
    db.close()
  }

  function heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): boolean {
    return stmts.heartbeat.run(leaseExpiresAt, Date.now(), runId, leaseOwner).changes > 0
  }

  function reclaimStale(): Run[] {
    const reclaimTransaction = db.transaction(() => {
      const now = Date.now()
      const rows = stmts.reclaimStaleSelect.all(now) as RunRow[]
      const reclaimed: Run[] = []

      for (const row of rows) {
        const timeline: TimelineEntry[] = JSON.parse(row.timeline)
        timeline.push({ state: 'idle', timestamp: now, error: 'lease expired' })
        stmts.reclaimStaleUpdate.run(JSON.stringify(timeline), row.id)
        reclaimed.push(
          rowToRun({
            ...row,
            state: 'idle',
            attempt: row.attempt + 1,
            timeline: JSON.stringify(timeline),
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
          }),
        )
      }

      return reclaimed
    })

    return reclaimTransaction()
  }

  return {
    create,
    createMany,
    transition,
    setResult,
    updateContext,
    claimIdle,
    get,
    getByProcess,
    getByState,
    getAll,
    getChain,
    hasActiveRun,
    hasIdempotencyKey,
    getByIdempotencyKey,
    prepareRetry,
    resetAttempt,
    heartbeat,
    reclaimStale,
    setHandlerVersion,
    countByState,
    hasState,
    getByStatePaginated,
    getByStatusPaginated,
    pruneCompletedBefore,
    close,
  }
}

export function createSqliteRunStore(dbPath: string): RunStore {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  applyMigrations(db)
  return createSqliteRunStoreFromDb(db)
}

function createSqliteEffectStore(db: Database.Database): EffectStore {
  const stmts = {
    get: db.prepare('SELECT * FROM run_effects WHERE run_id = ? AND effect_key = ?'),
    getAll: db.prepare('SELECT * FROM run_effects WHERE run_id = ?'),
    upsertStarted: db.prepare(`
      INSERT INTO run_effects (run_id, effect_key, state, output, error, started_at, completed_at)
      VALUES (?, ?, 'started', NULL, NULL, ?, NULL)
      ON CONFLICT(run_id, effect_key) DO UPDATE SET state='started', output=NULL, error=NULL, started_at=excluded.started_at, completed_at=NULL
    `),
    markCompleted: db.prepare("UPDATE run_effects SET state='completed', output=?, completed_at=? WHERE run_id=? AND effect_key=?"),
    markFailed: db.prepare("UPDATE run_effects SET state='failed', error=?, completed_at=? WHERE run_id=? AND effect_key=?"),
    deleteByRunId: db.prepare('DELETE FROM run_effects WHERE run_id = ?'),
  }

  type EffectRow = {
    run_id: string
    effect_key: string
    state: string
    output: string | null
    error: string | null
    started_at: number
    completed_at: number | null
  }

  function rowToEffect(row: EffectRow): EffectRecord {
    return {
      runId: row.run_id,
      effectKey: row.effect_key,
      state: row.state as EffectRecord['state'],
      output: row.output ? JSON.parse(row.output) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }

  function getEffect(runId: string, effectKey: string): EffectRecord | null {
    const row = stmts.get.get(runId, effectKey) as EffectRow | undefined
    return row ? rowToEffect(row) : null
  }

  function markStarted(runId: string, effectKey: string): void {
    stmts.upsertStarted.run(runId, effectKey, Date.now())
  }

  function markCompleted(runId: string, effectKey: string, output: unknown): void {
    stmts.markCompleted.run(JSON.stringify(output), Date.now(), runId, effectKey)
  }

  function markFailed(runId: string, effectKey: string, error: string): void {
    stmts.markFailed.run(error, Date.now(), runId, effectKey)
  }

  function getEffects(runId: string): EffectRecord[] {
    const rows = stmts.getAll.all(runId) as EffectRow[]
    return rows.map(rowToEffect)
  }

  function deleteEffectsForRuns(runIds: string[]): number {
    let deleted = 0
    for (const runId of runIds) {
      const result = stmts.deleteByRunId.run(runId)
      deleted += result.changes
    }
    return deleted
  }

  return { getEffect, getEffects, markStarted, markCompleted, markFailed, deleteEffectsForRuns }
}

export function createSqliteStores(dbPath: string): { runStore: RunStore; effectStore: EffectStore; observabilityStore: ReturnType<typeof createSqliteEngineObservabilityStore>; close: () => void } {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  applyMigrations(db)

  const runStore = createSqliteRunStoreFromDb(db)
  const effectStore = createSqliteEffectStore(db)
  const observabilityStore = createSqliteEngineObservabilityStore(db)

  return {
    runStore,
    effectStore,
    observabilityStore,
    close: () => db.close(),
  }
}
