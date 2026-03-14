import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createEngine, ErrorCode } from './index.js'
import { createSqliteRunStore } from './run-sqlite.js'
import type { Run } from './types.js'

function forceStaleRunningLease(dbPath: string, run: Run): void {
  const db = new Database(dbPath)
  db.prepare(
    `
    UPDATE runs
    SET state = 'running',
        result = NULL,
        timeline = ?,
        completed_at = NULL,
        attempt = ?,
        retry_after = ?,
        lease_owner = ?,
        lease_expires_at = ?,
        heartbeat_at = ?
    WHERE id = ?
  `,
  ).run(JSON.stringify(run.timeline), run.attempt, run.retryAfter, run.leaseOwner, Date.now() - 1, run.heartbeatAt ?? Date.now() - 10, run.id)
  db.close()
}

// ── SQLite restart persistence ──

describe('SQLite restart persistence', () => {
  let tmpFile: string

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-wal')
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-shm')
    } catch {}
  })

  it('idle runs from previous engine are processed after restart via kick()', async () => {
    tmpFile = path.join(os.tmpdir(), `state-restart-${Date.now()}.db`)

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      concurrency: 0,
    })
    engine1.register('proc', 'evt', async () => ({ success: true, payload: 'restarted' }))
    const runs = engine1.emit('evt', { data: 'test' })
    expect(runs).toHaveLength(1)
    expect(engine1.getIdle()).toHaveLength(1)
    engine1.stop()

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
    })
    engine2.register('proc', 'evt', async () => ({ success: true, payload: 'restarted' }))

    await engine2.drain()

    const completed = engine2.getCompleted()
    expect(completed).toHaveLength(1)
    expect(completed[0].result!.payload).toBe('restarted')
    engine2.stop()
  })

  it('completed/errored runs from previous engine are NOT re-processed', async () => {
    tmpFile = path.join(os.tmpdir(), `state-restart-noreprocess-${Date.now()}.db`)

    let callCount = 0

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
    })
    engine1.register('proc', 'evt', async () => {
      callCount++
      return { success: true }
    })
    engine1.emit('evt', null)
    await engine1.drain()
    expect(engine1.getCompleted()).toHaveLength(1)
    expect(callCount).toBe(1)
    engine1.stop()

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
    })
    engine2.register('proc', 'evt', async () => {
      callCount++
      return { success: true }
    })
    engine2.start()

    await new Promise((r) => setTimeout(r, 50))

    expect(callCount).toBe(1)
    expect(engine2.getCompleted()).toHaveLength(1)
    expect(engine2.getIdle()).toHaveLength(0)
    engine2.stop()
  })
})

// ── Lease-based crash recovery ──

describe('lease-based crash recovery (SQLite)', () => {
  let tmpFile: string

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-wal')
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-shm')
    } catch {}
  })

  it('engine1 claims run → hard stop → lease expires → engine2 reclaims and completes', async () => {
    tmpFile = path.join(os.tmpdir(), `state-crash-${Date.now()}.db`)

    // Engine1: register a handler that hangs forever, claim a run
    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000, // won't fire, we stop before
    })
    engine1.register('proc', 'evt', async () => {
      // This handler would hang forever, simulates a crash
      await new Promise(() => {})
      return { success: true }
    })
    engine1.emit('evt', { data: 'crash-test' })

    // Wait for the run to be claimed (running state)
    await new Promise((r) => setTimeout(r, 50))

    // Verify the run is in running state with a lease
    const store1 = createSqliteRunStore(tmpFile)
    const running = store1.getByState('running')
    expect(running).toHaveLength(1)
    expect(running[0].leaseOwner).not.toBeNull()
    store1.close!()

    // Stop the engine, then restore the stale running row to simulate a real crash residue.
    await engine1.stop()
    forceStaleRunningLease(tmpFile, running[0])

    // Engine2: starts up, reclaims the stale run, completes it
    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
    })
    engine2.register('proc', 'evt', async () => ({ success: true, payload: 'recovered' }))

    await engine2.drain()

    const completed = engine2.getCompleted()
    expect(completed).toHaveLength(1)
    expect(completed[0].result!.payload).toBe('recovered')
    expect(completed[0].attempt).toBe(1) // incremented from reclaim
    engine2.stop()
  })

  it('reclaimed run with exhausted retries transitions to errored', async () => {
    tmpFile = path.join(os.tmpdir(), `state-crash-dead-${Date.now()}.db`)
    let deadRun: any = null

    // Engine1: register with retry policy, simulate crash
    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000,
      retry: { maxRetries: 0 }, // no retries allowed
    })
    engine1.register('proc', 'evt', async () => {
      await new Promise(() => {})
      return { success: true }
    })
    engine1.emit('evt', null)

    await new Promise((r) => setTimeout(r, 50))
    const store1 = createSqliteRunStore(tmpFile)
    const [running] = store1.getByState('running')
    store1.close!()
    await engine1.stop()
    forceStaleRunningLease(tmpFile, running)

    // Engine2: reclaims, but retry budget exhausted → errored
    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      retry: { maxRetries: 0 },
      onDead: (run, error) => {
        deadRun = { run, error }
      },
    })
    engine2.register('proc', 'evt', async () => ({ success: true }))
    engine2.start()

    // Wait for startup recovery
    await new Promise((r) => setTimeout(r, 50))

    const errored = engine2.getErrored()
    expect(errored).toHaveLength(1)
    expect(errored[0].result!.error).toContain('lease expired')

    expect(deadRun).not.toBeNull()
    expect(deadRun.error).toContain('lease expired')
    engine2.stop()
  })

  it('onRetry hook fires for reclaimed runs', async () => {
    tmpFile = path.join(os.tmpdir(), `state-crash-retry-${Date.now()}.db`)
    let retryInfo: any = null

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000,
      retry: { maxRetries: 3 },
    })
    engine1.register('proc', 'evt', async () => {
      await new Promise(() => {})
      return { success: true }
    })
    engine1.emit('evt', null)

    await new Promise((r) => setTimeout(r, 50))
    const store1 = createSqliteRunStore(tmpFile)
    const [running] = store1.getByState('running')
    store1.close!()
    await engine1.stop()
    forceStaleRunningLease(tmpFile, running)

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      retry: { maxRetries: 3 },
      onRetry: (run, error, attempt) => {
        retryInfo = { run, error, attempt }
      },
    })
    engine2.register('proc', 'evt', async () => ({ success: true, payload: 'retried' }))

    await engine2.drain()

    expect(retryInfo).not.toBeNull()
    expect(retryInfo.error).toBe('lease expired')

    const completed = engine2.getCompleted()
    expect(completed).toHaveLength(1)
    engine2.stop()
  })

  it('timeline shows lease-expired entry after recovery', async () => {
    tmpFile = path.join(os.tmpdir(), `state-crash-timeline-${Date.now()}.db`)

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000,
    })
    engine1.register('proc', 'evt', async () => {
      await new Promise(() => {})
      return { success: true }
    })
    const [run1] = engine1.emit('evt', null)

    await new Promise((r) => setTimeout(r, 50))
    const store1 = createSqliteRunStore(tmpFile)
    const [running] = store1.getByState('running')
    store1.close!()
    await engine1.stop()
    forceStaleRunningLease(tmpFile, running)

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
    })
    engine2.register('proc', 'evt', async () => ({ success: true }))

    await engine2.drain()

    const completed = engine2.getRun(run1.id)!
    const leaseExpiredEntry = completed.timeline.find((e) => e.error === 'lease expired')
    expect(leaseExpiredEntry).toBeDefined()
    expect(leaseExpiredEntry!.state).toBe('idle')
    engine2.stop()
  })

  it('normal completion clears lease fields', async () => {
    tmpFile = path.join(os.tmpdir(), `state-lease-clear-${Date.now()}.db`)

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 30_000,
    })
    engine1.register('proc', 'evt', async () => ({ success: true }))
    engine1.emit('evt', null)

    await engine1.drain()

    const store = createSqliteRunStore(tmpFile)
    const runs = store.getAll()
    expect(runs).toHaveLength(1)
    expect(runs[0].state).toBe('completed')
    expect(runs[0].leaseOwner).toBeNull()
    expect(runs[0].leaseExpiresAt).toBeNull()
    expect(runs[0].heartbeatAt).toBeNull()
    store.close!()
    engine1.stop()
  })
})

// ── Cross-process idempotency (SQLite) ──

describe('cross-process idempotency (SQLite)', () => {
  it('constraint error from racing process is handled gracefully', () => {
    // Simulate: another process already created a run with same idempotency key + process name.
    const store = createSqliteRunStore(':memory:')

    // Pre-insert a run as if another process created it
    store.create('proc', 'evt', null, null, undefined, undefined, 0, 'race-key')

    // Same process + same key → UNIQUE constraint fires
    expect(() => store.create('proc', 'evt', null, null, undefined, undefined, 0, 'race-key')).toThrow(/UNIQUE constraint failed/)

    // Different process + same key → allowed (composite index)
    expect(() => store.create('proc2', 'evt', null, null, undefined, undefined, 0, 'race-key')).not.toThrow()

    store.close!()
  })
})

// ── Multi-worker correctness tests ──

describe('multi-worker correctness (SQLite)', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `multi-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  })

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-wal')
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '-shm')
    } catch {}
  })

  it('two engines racing to claim, only one wins', async () => {
    let callCount = 0
    const engine1 = createEngine({ store: { type: 'sqlite', path: tmpFile } })
    const engine2 = createEngine({ store: { type: 'sqlite', path: tmpFile } })

    const handler = async () => {
      callCount++
      await new Promise((r) => setTimeout(r, 50))
      return { success: true as const }
    }

    engine1.register('proc', 'evt', handler)
    engine2.register('proc', 'evt', handler)

    engine1.emit('evt', { test: true })

    await engine1.drain()

    await new Promise((r) => setTimeout(r, 100))

    const store = createSqliteRunStore(tmpFile)
    const allRuns = store.getAll()
    const completed = allRuns.filter((r) => r.state === 'completed')
    expect(completed).toHaveLength(1)
    expect(callCount).toBe(1)
    store.close!()

    await engine1.stop()
    await engine2.stop()
  })

  it('graceful stop keeps the lease alive until the active handler finishes', async () => {
    let callCount = 0
    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 60,
      heartbeatIntervalMs: 20,
    })

    const handler = async () => {
      callCount++
      await new Promise((r) => setTimeout(r, 150))
      return { success: true as const }
    }

    engine1.register('proc', 'evt', handler)

    engine1.emit('evt', null)
    await new Promise((r) => setTimeout(r, 20))

    const stopPromise = engine1.stop({ graceful: true, timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 90))

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 60,
      heartbeatIntervalMs: 20,
    })
    engine2.register('proc', 'evt', handler)

    await stopPromise
    await new Promise((r) => setTimeout(r, 120))

    const store = createSqliteRunStore(tmpFile)
    const completed = store.getByState('completed')
    expect(completed).toHaveLength(1)
    expect(callCount).toBe(1)
    store.close!()

    await engine2.stop()
  })

  it('effect deduplication across crash/recovery', async () => {
    let effectCallCount = 0

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000, // won't fire, we stop before
    })

    engine1.register('proc', 'evt', async (ctx) => {
      await ctx.effect('charge', () => {
        effectCallCount++
        return { chargeId: 'ch_abc' }
      })
      // Hang forever after effect completes, simulates crash
      return await new Promise(() => {})
    })

    engine1.emit('evt', null)
    // Wait for handler to execute (effect completes, then handler hangs)
    await new Promise((r) => setTimeout(r, 50))
    // Hard stop engine1, lease will expire
    await engine1.stop()

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 150))

    // Engine2 starts, reclaims the run
    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
    })

    engine2.register('proc', 'evt', async (ctx) => {
      const val = await ctx.effect('charge', () => {
        effectCallCount++
        return { chargeId: 'should_not_reach' }
      })
      // This time succeed
      return { success: true, payload: val }
    })

    await engine2.drain(5000)

    const completed = engine2.getCompleted()
    expect(completed).toHaveLength(1)
    expect(completed[0].result!.payload).toEqual({ chargeId: 'ch_abc' })
    // Effect fn was called only once (by engine1), engine2 replayed stored output
    expect(effectCallCount).toBe(1)

    await engine2.stop()
  })

  it('does not execute an effect again when a reclaimed run sees an in-progress effect record', async () => {
    let effectCallCount = 0

    const engine1 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      handlerTimeoutMs: 60_000,
    })

    engine1.register('proc', 'evt', async (ctx) => {
      await ctx.effect('charge', async () => {
        effectCallCount++
        return await new Promise(() => {})
      })
      return { success: true }
    })

    engine1.emit('evt', null)
    await new Promise((r) => setTimeout(r, 50))
    await engine1.stop()
    await new Promise((r) => setTimeout(r, 150))

    const engine2 = createEngine({
      store: { type: 'sqlite', path: tmpFile },
      leaseTimeoutMs: 100,
      retry: { maxRetries: 0 },
    })

    engine2.register('proc', 'evt', async (ctx) => {
      await ctx.effect('charge', () => {
        effectCallCount++
        return { chargeId: 'duplicate' }
      })
      return { success: true }
    })
    engine2.start()

    await new Promise((r) => setTimeout(r, 100))

    expect(effectCallCount).toBe(1)
    expect(engine2.getErrored()).toHaveLength(1)

    await engine2.stop()
  })

  it('idempotency key enforced across engines', async () => {
    const engine1 = createEngine({ store: { type: 'sqlite', path: tmpFile } })
    const engine2 = createEngine({ store: { type: 'sqlite', path: tmpFile } })

    engine1.register('proc', 'evt', async () => ({ success: true }))
    engine2.register('proc', 'evt', async () => ({ success: true }))

    const runs1 = engine1.emit('evt', null, { idempotencyKey: 'unique-key' })
    const runs2 = engine2.emit('evt', null, { idempotencyKey: 'unique-key' })

    expect(runs1).toHaveLength(1)
    expect(runs2).toHaveLength(0) // duplicate returns empty

    await engine1.stop()
    await engine2.stop()
  })
})

// ── STATE_DB_PATH env var ──

describe('STATE_DB_PATH env var', () => {
  const originalEnv = process.env.STATE_DB_PATH

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.STATE_DB_PATH
    } else {
      process.env.STATE_DB_PATH = originalEnv
    }
  })

  it('uses STATE_DB_PATH when store option not set', async () => {
    const tmpFile = path.join(os.tmpdir(), `env-test-${Date.now()}.db`)

    try {
      process.env.STATE_DB_PATH = tmpFile
      const engine = createEngine() // no store option
      engine.register('proc', 'evt', async () => ({ success: true }))
      const [run] = await engine.emitAndWait('evt', null)
      expect(engine.getRun(run.id)!.state).toBe('completed')
      await engine.stop()

      // Verify the DB file was created (proves SQLite was used)
      expect(fs.existsSync(tmpFile)).toBe(true)
    } finally {
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-wal')
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-shm')
      } catch {}
    }
  })

  it('explicit store option takes precedence over env var', async () => {
    process.env.STATE_DB_PATH = '/tmp/should-not-be-used.db'
    const engine = createEngine({ store: 'memory' })
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = await engine.emitAndWait('evt', null)
    expect(engine.getRun(run.id)!.state).toBe('completed')
    await engine.stop()

    expect(fs.existsSync('/tmp/should-not-be-used.db')).toBe(false)
  })

  it('recovered work waits for explicit start so async registration can finish first', async () => {
    const tmpFile = path.join(os.tmpdir(), `state-start-barrier-${Date.now()}.db`)

    try {
      const engine1 = createEngine({
        store: { type: 'sqlite', path: tmpFile },
        concurrency: 0,
      })
      engine1.register('proc', 'evt', async () => ({ success: true, payload: 'recovered-after-start' }))
      engine1.emit('evt', null)
      await engine1.stop()

      const engine2 = createEngine({
        store: { type: 'sqlite', path: tmpFile },
      })

      await Promise.resolve()
      engine2.register('proc', 'evt', async () => ({ success: true, payload: 'recovered-after-start' }))
      engine2.start()
      await engine2.drain()

      expect(engine2.getCompleted()).toHaveLength(1)
      expect(engine2.getCompleted()[0].result?.payload).toBe('recovered-after-start')
      expect(engine2.getErrored()).toHaveLength(0)
      await engine2.stop()
    } finally {
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-wal')
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-shm')
      } catch {}
    }
  })
})
