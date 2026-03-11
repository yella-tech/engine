import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { isDeferredRun } from './status.js'
import type { EffectRecord, EffectStore, HandlerResult, ProcessState, Run, RunStore, TimelineEntry } from './types.js'
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

function createSqliteRunStoreFromDb(db: Database.Database): RunStore {
  // Prepared statements
  const stmts = {
    insert: db.prepare(`
      INSERT INTO runs (id, correlation_id, process_name, event_name, state, context, payload, result, timeline, parent_run_id, child_run_ids, started_at, completed_at, depth, idempotency_key, attempt, retry_after, lease_owner, lease_expires_at, heartbeat_at, handler_version)
      VALUES (@id, @correlation_id, @process_name, @event_name, @state, @context, @payload, @result, @timeline, @parent_run_id, @child_run_ids, @started_at, @completed_at, @depth, @idempotency_key, @attempt, @retry_after, @lease_owner, @lease_expires_at, @heartbeat_at, @handler_version)
    `),
    getById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    updateState: db.prepare('UPDATE runs SET state = ?, timeline = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL WHERE id = ?'),
    updateResult: db.prepare('UPDATE runs SET result = ? WHERE id = ?'),
    updateContext: db.prepare('UPDATE runs SET context = ? WHERE id = ?'),
    updateChildRunIds: db.prepare('UPDATE runs SET child_run_ids = ? WHERE id = ?'),
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
    paginatedByState: db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    paginatedAll: db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?'),
    countAll: db.prepare('SELECT COUNT(*) as cnt FROM runs'),
    paginatedByStateRoot: db.prepare("SELECT * FROM runs WHERE state = ? AND parent_run_id IS NULL ORDER BY started_at DESC LIMIT ? OFFSET ?"),
    paginatedAllRoot: db.prepare("SELECT * FROM runs WHERE parent_run_id IS NULL ORDER BY started_at DESC LIMIT ? OFFSET ?"),
    countByStateRoot: db.prepare("SELECT COUNT(*) as cnt FROM runs WHERE state = ? AND parent_run_id IS NULL"),
    countAllRoot: db.prepare("SELECT COUNT(*) as cnt FROM runs WHERE parent_run_id IS NULL"),
    pruneCompletedCandidates: db.prepare("SELECT * FROM runs WHERE state = 'completed' AND completed_at IS NOT NULL AND completed_at < ?"),
    clearParentRunIds: db.prepare('UPDATE runs SET parent_run_id = NULL WHERE parent_run_id = ?'),
    deleteById: db.prepare('DELETE FROM runs WHERE id = ?'),
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
    const id = crypto.randomUUID()
    const now = Date.now()
    const timeline: TimelineEntry[] = [{ state: 'idle', timestamp: now, event: eventName, payload }]

    const run: Run = {
      id,
      correlationId: correlationId ?? id,
      processName,
      eventName,
      state: 'idle',
      context: context ? { ...context } : {},
      payload,
      result: null,
      timeline,
      parentRunId: parentRunId ?? null,
      childRunIds: [],
      startedAt: now,
      completedAt: null,
      depth: depth ?? 0,
      idempotencyKey: idempotencyKey ?? null,
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

    if (parentRunId) {
      const parentRow = stmts.getById.get(parentRunId) as RunRow | undefined
      if (parentRow) {
        const childIds: string[] = JSON.parse(parentRow.child_run_ids)
        childIds.push(id)
        stmts.updateChildRunIds.run(JSON.stringify(childIds), parentRunId)
      }
    }

    return run
  }

  function transition(runId: string, state: ProcessState, meta?: { error?: string; event?: string; payload?: unknown }): Run {
    const row = stmts.getById.get(runId) as RunRow | undefined
    if (!row) throw new Error(`Run not found: ${runId}`)

    const currentState = row.state as ProcessState
    const allowed = VALID_TRANSITIONS[currentState]
    if (!allowed.includes(state)) {
      throw new Error(`Invalid transition: ${currentState} → ${state}`)
    }

    const timeline: TimelineEntry[] = JSON.parse(row.timeline)
    const entry: TimelineEntry = { state, timestamp: Date.now() }
    if (meta?.error) entry.error = meta.error
    if (meta?.event) entry.event = meta.event
    if (meta?.payload !== undefined) entry.payload = meta.payload
    timeline.push(entry)

    const completedAt = state === 'completed' || state === 'errored' ? Date.now() : row.completed_at

    stmts.updateState.run(state, JSON.stringify(timeline), completedAt, runId)

    return rowToRun({
      ...row,
      state,
      timeline: JSON.stringify(timeline),
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

  function getByStatePaginated(state: ProcessState | null, limit: number, offset: number, opts?: { root?: boolean }): { runs: Run[]; total: number } {
    const root = opts?.root ?? false
    let rows: RunRow[]
    let total: number

    if (state && root) {
      rows = stmts.paginatedByStateRoot.all(state, limit, offset) as RunRow[]
      total = (stmts.countByStateRoot.get(state) as { cnt: number }).cnt
    } else if (state) {
      rows = stmts.paginatedByState.all(state, limit, offset) as RunRow[]
      total = (stmts.countByState.get(state) as { cnt: number }).cnt
    } else if (root) {
      rows = stmts.paginatedAllRoot.all(limit, offset) as RunRow[]
      total = (stmts.countAllRoot.get() as { cnt: number }).cnt
    } else {
      rows = stmts.paginatedAll.all(limit, offset) as RunRow[]
      total = (stmts.countAll.get() as { cnt: number }).cnt
    }

    return { runs: rows.map(rowToRun), total }
  }

  function pruneCompletedBefore(cutoffMs: number): string[] {
    const pruneTransaction = db.transaction(() => {
      const candidateRows = stmts.pruneCompletedCandidates.all(cutoffMs) as RunRow[]
      const candidates = candidateRows.map(rowToRun).filter((run) => !isDeferredRun(run))
      if (candidates.length === 0) return []

      const prunedIds = new Set(candidates.map((run) => run.id))
      const impactedParentIds = new Set(candidates.map((run) => run.parentRunId).filter((id): id is string => id !== null))

      for (const parentId of impactedParentIds) {
        const parentRow = stmts.getById.get(parentId) as RunRow | undefined
        if (!parentRow) continue
        const nextChildIds = (JSON.parse(parentRow.child_run_ids) as string[]).filter((childId) => !prunedIds.has(childId))
        stmts.updateChildRunIds.run(JSON.stringify(nextChildIds), parentId)
      }

      for (const runId of prunedIds) {
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

  function heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): void {
    stmts.heartbeat.run(leaseExpiresAt, Date.now(), runId, leaseOwner)
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

export function createSqliteStores(dbPath: string): { runStore: RunStore; effectStore: EffectStore; close: () => void } {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  applyMigrations(db)

  const runStore = createSqliteRunStoreFromDb(db)
  const effectStore = createSqliteEffectStore(db)

  return {
    runStore,
    effectStore,
    close: () => db.close(),
  }
}
