import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSqliteRunStore } from './run-sqlite.js'
import type { RunStore } from './types.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

function downgradeSchemaToV9(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(`
    DROP TABLE run_emissions;
    DROP TABLE run_singleton_meta;
    DROP TABLE active_singletons;
    PRAGMA user_version = 9;
  `)
  db.close()
}

describe('createSqliteRunStore', () => {
  let store: RunStore

  beforeEach(() => {
    store = createSqliteRunStore(':memory:')
  })

  afterEach(() => {
    store.close?.()
  })

  describe('create', () => {
    it('returns run with correct fields and state=idle', () => {
      const run = store.create('proc', 'event', { x: 1 })
      expect(run.processName).toBe('proc')
      expect(run.eventName).toBe('event')
      expect(run.state).toBe('idle')
      expect(run.payload).toEqual({ x: 1 })
      expect(run.result).toBeNull()
      expect(run.parentRunId).toBeNull()
      expect(run.childRunIds).toEqual([])
      expect(run.completedAt).toBeNull()
      expect(run.startedAt).toBeGreaterThan(0)
    })

    it('has initial timeline entry', () => {
      const run = store.create('proc', 'event', 'data')
      expect(run.timeline).toHaveLength(1)
      expect(run.timeline[0].state).toBe('idle')
      expect(run.timeline[0].event).toBe('event')
      expect(run.timeline[0].payload).toBe('data')
    })

    it('auto-generates UUID and correlationId', () => {
      const run = store.create('proc', 'event', null)
      expect(run.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(run.correlationId).toBe(run.id)
    })

    it('uses provided correlationId and context', () => {
      const run = store.create('proc', 'event', null, null, 'corr-123', { key: 'val' })
      expect(run.correlationId).toBe('corr-123')
      expect(run.context).toEqual({ key: 'val' })
    })

    it('links parent-child (parent.childRunIds updated)', () => {
      const parent = store.create('p', 'e', null)
      const child = store.create('c', 'e', null, parent.id)
      expect(child.parentRunId).toBe(parent.id)

      const updatedParent = store.get(parent.id)!
      expect(updatedParent.childRunIds).toContain(child.id)
    })
  })

  describe('transition', () => {
    it('updates state and appends timeline entry', () => {
      const run = store.create('proc', 'event', null)
      const updated = store.transition(run.id, 'running')
      expect(updated.state).toBe('running')
      expect(updated.timeline).toHaveLength(2)
      expect(updated.timeline[1].state).toBe('running')
    })

    it('sets completedAt on completed', () => {
      const run = store.create('proc', 'event', null)
      store.transition(run.id, 'running')
      const completed = store.transition(run.id, 'completed')
      expect(completed.completedAt).toBeGreaterThan(0)
    })

    it('sets completedAt on errored', () => {
      const run = store.create('proc', 'event', null)
      store.transition(run.id, 'running')
      const errored = store.transition(run.id, 'errored', { error: 'fail' })
      expect(errored.completedAt).toBeGreaterThan(0)
    })

    it('throws for unknown runId', () => {
      expect(() => store.transition('nonexistent', 'running')).toThrow('Run not found: nonexistent')
    })

    it('includes error/event/payload metadata in timeline', () => {
      const run = store.create('proc', 'event', null)
      store.transition(run.id, 'running')
      const errored = store.transition(run.id, 'errored', {
        error: 'boom',
        event: 'triggerEvt',
        payload: { detail: 42 },
      })
      const last = errored.timeline[errored.timeline.length - 1]
      expect(last.error).toBe('boom')
      expect(last.event).toBe('triggerEvt')
      expect(last.payload).toEqual({ detail: 42 })
    })
  })

  describe('setResult', () => {
    it('stores result on run', () => {
      const run = store.create('proc', 'event', null)
      store.setResult(run.id, { success: true, payload: 'done' })
      const fetched = store.get(run.id)!
      expect(fetched.result).toEqual({ success: true, payload: 'done' })
    })

    it('throws for unknown runId', () => {
      expect(() => store.setResult('ghost', { success: true })).toThrow('Run not found: ghost')
    })
  })

  describe('updateContext', () => {
    it('sets key on run context', () => {
      const run = store.create('proc', 'event', null)
      store.updateContext(run.id, 'foo', 'bar')
      const fetched = store.get(run.id)!
      expect(fetched.context.foo).toBe('bar')
    })

    it('throws for unknown runId', () => {
      expect(() => store.updateContext('ghost', 'k', 'v')).toThrow('Run not found: ghost')
    })
  })

  describe('claimIdle', () => {
    it('returns up to N idle runs and transitions them to running', () => {
      store.create('a', 'e', null)
      store.create('b', 'e', null)
      store.create('c', 'e', null)
      const claimed = store.claimIdle(2)
      expect(claimed).toHaveLength(2)
      for (const run of claimed) {
        const fresh = store.get(run.id)!
        expect(fresh.state).toBe('running')
      }
    })

    it('returns empty array when no idle runs', () => {
      expect(store.claimIdle(5)).toEqual([])
    })

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) store.create('p', 'e', null)
      const claimed = store.claimIdle(3)
      expect(claimed).toHaveLength(3)
    })

    it('claimed runs are running before return (atomic)', () => {
      store.create('a', 'e', null)
      store.create('b', 'e', null)
      const claimed = store.claimIdle(2)
      // Verify via direct DB read that they're running
      for (const run of claimed) {
        expect(run.state).toBe('running')
        const fresh = store.get(run.id)!
        expect(fresh.state).toBe('running')
      }
      // No idle runs left
      expect(store.getByState('idle')).toHaveLength(0)
    })
  })

  it('builds claim update SQL with idle-state guard to avoid double-claim races', () => {
    const preparedSql: string[] = []
    const originalPrepare = Database.prototype.prepare

    ;(Database.prototype as any).prepare = function (...args: unknown[]) {
      const [sql] = args
      if (typeof sql === 'string') preparedSql.push(sql)
      return (originalPrepare as any).apply(this, args)
    }

    let probeStore: RunStore | null = null
    try {
      probeStore = createSqliteRunStore(':memory:')
    } finally {
      ;(Database.prototype as any).prepare = originalPrepare
      probeStore?.close?.()
    }

    const normalized = preparedSql.map((sql) => sql.replace(/\s+/g, ' ').trim())
    const claimUpdate = normalized.find((sql) => sql.includes("state = 'idle'") && sql.includes('retry_after <= ?'))
    expect(claimUpdate).toContain("WHERE id = ? AND state = 'idle' AND (retry_after IS NULL OR retry_after <= ?)")
  })

  describe('get', () => {
    it('returns null for unknown id', () => {
      expect(store.get('nope')).toBeNull()
    })
  })

  describe('getByProcess', () => {
    it('filters by process name', () => {
      store.create('alpha', 'e', null)
      store.create('beta', 'e', null)
      store.create('alpha', 'e2', null)
      expect(store.getByProcess('alpha')).toHaveLength(2)
      expect(store.getByProcess('beta')).toHaveLength(1)
    })
  })

  describe('getByState', () => {
    it('filters by state', () => {
      const r1 = store.create('a', 'e', null)
      store.create('b', 'e', null)
      store.transition(r1.id, 'running')
      expect(store.getByState('idle')).toHaveLength(1)
      expect(store.getByState('running')).toHaveLength(1)
    })
  })

  describe('getByStatusPaginated', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('separates completed from deferred and supports root-only ascending queries', () => {
      vi.useFakeTimers()

      const completed = store.create('completed', 'evt', null)
      store.transition(completed.id, 'running')
      store.setResult(completed.id, { success: true })
      store.transition(completed.id, 'completed')

      vi.advanceTimersByTime(10)

      const deferred = store.create('deferred', 'evt', null)
      store.transition(deferred.id, 'running')
      store.setResult(deferred.id, { success: true, triggerEvent: 'next', deferred: true })
      store.transition(deferred.id, 'completed')

      vi.advanceTimersByTime(10)

      const childDeferred = store.create('child-deferred', 'evt', null, deferred.id)
      store.transition(childDeferred.id, 'running')
      store.setResult(childDeferred.id, { success: true, triggerEvent: 'child:next', deferred: true })
      store.transition(childDeferred.id, 'completed')

      const deferredPage = store.getByStatusPaginated!('deferred', 10, 0, { root: true, order: 'asc' })
      expect(deferredPage.total).toBe(1)
      expect(deferredPage.runs).toHaveLength(1)
      expect(deferredPage.runs[0].id).toBe(deferred.id)

      const completedPage = store.getByStatusPaginated!('completed', 10, 0)
      expect(completedPage.total).toBe(1)
      expect(completedPage.runs[0].id).toBe(completed.id)
    })
  })

  describe('getAll', () => {
    it('returns all runs', () => {
      store.create('a', 'e', null)
      store.create('b', 'e', null)
      expect(store.getAll()).toHaveLength(2)
    })
  })

  describe('getChain', () => {
    it('BFS traversal of parent + descendants', () => {
      const root = store.create('r', 'e', null)
      const child1 = store.create('c1', 'e', null, root.id)
      const child2 = store.create('c2', 'e', null, root.id)
      const grandchild = store.create('gc', 'e', null, child1.id)

      const chain = store.getChain(root.id)
      expect(chain).toHaveLength(4)
      expect(chain[0].id).toBe(root.id)
      expect(chain.map((r) => r.id)).toContain(child1.id)
      expect(chain.map((r) => r.id)).toContain(child2.id)
      expect(chain.map((r) => r.id)).toContain(grandchild.id)
    })

    it('returns empty array for unknown id', () => {
      expect(store.getChain('nope')).toEqual([])
    })
  })

  describe('pruneCompletedBefore', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('prunes completed non-deferred runs and reparents surviving children', () => {
      const parent = store.create('parent', 'evt', null)
      store.transition(parent.id, 'running')
      store.setResult(parent.id, { success: true })
      store.transition(parent.id, 'completed')

      const deferred = store.create('review', 'evt', null)
      store.transition(deferred.id, 'running')
      store.setResult(deferred.id, { success: true, triggerEvent: 'next', deferred: true })
      store.transition(deferred.id, 'completed')

      vi.advanceTimersByTime(100)

      const child = store.create('child', 'evt', null, parent.id)
      const pruned = store.pruneCompletedBefore!(Date.now() - 50)

      expect(pruned).toContain(parent.id)
      expect(pruned).not.toContain(deferred.id)
      expect(store.get(parent.id)).toBeNull()
      expect(store.get(deferred.id)).not.toBeNull()
      expect(store.get(child.id)?.parentRunId).toBeNull()
    })
  })

  // SQLite-specific tests

  describe('migrations', () => {
    it('schema created on init (table and indexes exist)', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      // Manually check that createSqliteRunStore creates the schema
      const testStore = createSqliteRunStore(':memory:')
      // If we get here without error, migrations ran
      testStore.create('test', 'event', null)
      const run = testStore.getAll()
      expect(run).toHaveLength(1)
      testStore.close?.()
      db.close()
    })
  })

  describe('persistence', () => {
    it('data survives close + reopen (temp file)', () => {
      const tmpFile = path.join(os.tmpdir(), `state-test-${Date.now()}.db`)
      try {
        const store1 = createSqliteRunStore(tmpFile)
        const run = store1.create('proc', 'event', { persistent: true })
        store1.transition(run.id, 'running')
        store1.setResult(run.id, { success: true })
        store1.close?.()

        const store2 = createSqliteRunStore(tmpFile)
        const fetched = store2.get(run.id)!
        expect(fetched).not.toBeNull()
        expect(fetched.processName).toBe('proc')
        expect(fetched.state).toBe('running')
        expect(fetched.result).toEqual({ success: true })
        store2.close?.()
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

  describe('idempotency unique index', () => {
    it('rejects duplicate idempotency key for same process at database level', () => {
      store.create('proc', 'evt', null, null, undefined, undefined, 0, 'unique-key')
      expect(() => store.create('proc', 'evt', null, null, undefined, undefined, 0, 'unique-key')).toThrow(/UNIQUE constraint failed/)
    })

    it('allows same idempotency key for different processes', () => {
      store.create('proc1', 'evt', null, null, undefined, undefined, 0, 'shared-key')
      store.create('proc2', 'evt', null, null, undefined, undefined, 0, 'shared-key')
      expect(store.getAll()).toHaveLength(2)
    })

    it('allows multiple null idempotency keys', () => {
      store.create('proc1', 'evt', null)
      store.create('proc2', 'evt', null)
      store.create('proc3', 'evt', null)
      expect(store.getAll()).toHaveLength(3)
    })
  })

  describe('lease fields', () => {
    it('created runs have null lease fields', () => {
      const run = store.create('proc', 'event', { x: 1 })
      expect(run.leaseOwner).toBeNull()
      expect(run.leaseExpiresAt).toBeNull()
      expect(run.heartbeatAt).toBeNull()
    })

    it('claimIdle with lease params sets lease fields', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      expect(claimed).toHaveLength(1)
      expect(claimed[0].leaseOwner).toBe('owner-1')
      expect(claimed[0].leaseExpiresAt).toBeGreaterThan(Date.now() - 1000)
      expect(claimed[0].heartbeatAt).toBeGreaterThan(0)
    })

    it('claimIdle without lease params leaves lease null (backward compat)', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1)
      expect(claimed).toHaveLength(1)
      expect(claimed[0].leaseOwner).toBeNull()
      expect(claimed[0].leaseExpiresAt).toBeNull()
      expect(claimed[0].heartbeatAt).toBeNull()
    })

    it('transition clears lease fields', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      const completed = store.transition(run.id, 'completed')
      expect(completed.leaseOwner).toBeNull()
      expect(completed.leaseExpiresAt).toBeNull()
      expect(completed.heartbeatAt).toBeNull()
      // Also verify via direct read
      const fetched = store.get(run.id)!
      expect(fetched.leaseOwner).toBeNull()
    })

    it('lease fields persist in SQLite', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const fetched = store.get(claimed[0].id)!
      expect(fetched.leaseOwner).toBe('owner-1')
      expect(fetched.leaseExpiresAt).toBeGreaterThan(0)
      expect(fetched.heartbeatAt).toBeGreaterThan(0)
    })
  })

  describe('heartbeat', () => {
    it('extends leaseExpiresAt for matching owner', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      const newExpiry = Date.now() + 60_000
      expect(store.heartbeat(run.id, 'owner-1', newExpiry)).toBe(true)
      const updated = store.get(run.id)!
      expect(updated.leaseExpiresAt).toBe(newExpiry)
      expect(updated.heartbeatAt).toBeGreaterThan(0)
    })

    it('is no-op for wrong owner', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      const originalExpiry = run.leaseExpiresAt
      expect(store.heartbeat(run.id, 'wrong-owner', Date.now() + 60_000)).toBe(false)
      const updated = store.get(run.id)!
      expect(updated.leaseExpiresAt).toBe(originalExpiry)
    })

    it('is no-op for non-running run', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      store.transition(run.id, 'completed')
      expect(store.heartbeat(run.id, 'owner-1', Date.now() + 60_000)).toBe(false)
      const updated = store.get(run.id)!
      expect(updated.leaseExpiresAt).toBeNull()
    })
  })

  describe('reclaimStale', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns expired-lease running runs', () => {
      store.create('proc', 'event', null)
      store.claimIdle(1, 'owner-1', 30_000)

      vi.advanceTimersByTime(31_000)

      const reclaimed = store.reclaimStale()
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0].state).toBe('idle')
    })

    it('transitions to idle, increments attempt, adds timeline entry', () => {
      store.create('proc', 'event', null)
      store.claimIdle(1, 'owner-1', 30_000)

      vi.advanceTimersByTime(31_000)

      const reclaimed = store.reclaimStale()
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0].attempt).toBe(1)
      const lastEntry = reclaimed[0].timeline[reclaimed[0].timeline.length - 1]
      expect(lastEntry.state).toBe('idle')
      expect(lastEntry.error).toBe('lease expired')
    })

    it('ignores runs with future lease expiry', () => {
      store.create('proc', 'event', null)
      store.claimIdle(1, 'owner-1', 60_000)

      vi.advanceTimersByTime(10_000)

      const reclaimed = store.reclaimStale()
      expect(reclaimed).toHaveLength(0)
    })

    it('ignores idle/completed runs', () => {
      store.create('proc', 'event', null)
      const reclaimed = store.reclaimStale()
      expect(reclaimed).toHaveLength(0)
    })

    it('clears lease fields on reclaimed runs', () => {
      store.create('proc', 'event', null)
      store.claimIdle(1, 'owner-1', 30_000)

      vi.advanceTimersByTime(31_000)

      const reclaimed = store.reclaimStale()
      expect(reclaimed[0].leaseOwner).toBeNull()
      expect(reclaimed[0].leaseExpiresAt).toBeNull()
      expect(reclaimed[0].heartbeatAt).toBeNull()

      // Also verify via direct read
      const fetched = store.get(reclaimed[0].id)!
      expect(fetched.leaseOwner).toBeNull()
      expect(fetched.state).toBe('idle')
    })

    it('reclaimed run can be re-claimed', () => {
      store.create('proc', 'event', null)
      store.claimIdle(1, 'owner-1', 30_000)

      vi.advanceTimersByTime(31_000)
      store.reclaimStale()

      const reclaimed = store.claimIdle(1, 'owner-2', 30_000)
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0].leaseOwner).toBe('owner-2')
      expect(reclaimed[0].state).toBe('running')
    })
  })

  describe('JSON round-trip', () => {
    it('complex payload/context/result serialize and deserialize correctly', () => {
      const complexPayload = {
        nested: { deeply: { value: [1, 'two', { three: true }] } },
        nullField: null,
        arr: [null, null, 0, ''], // undefined becomes null in JSON
      }
      const complexContext = { meta: { tags: ['a', 'b'], count: 42 } }

      const run = store.create('proc', 'event', complexPayload, null, undefined, complexContext)
      store.setResult(run.id, {
        success: true,
        payload: { response: [1, 2, 3] },
        triggerEvent: 'next',
      })

      const fetched = store.get(run.id)!
      expect(fetched.payload).toEqual(complexPayload)
      expect(fetched.context).toEqual(complexContext)
      expect(fetched.result).toEqual({
        success: true,
        payload: { response: [1, 2, 3] },
        triggerEvent: 'next',
      })
    })
  })

  describe('migration 9 -> 10', () => {
    it('backfills emission reservations from existing run rows', () => {
      const dbPath = path.join(os.tmpdir(), `run-sqlite-migration-idempotency-${Date.now()}.db`)
      const legacyStore = createSqliteRunStore(dbPath)
      legacyStore.create('proc', 'evt', { a: 1 }, null, undefined, undefined, undefined, 'dup-key')
      legacyStore.close?.()
      downgradeSchemaToV9(dbPath)

      const migratedStore = createSqliteRunStore(dbPath)
      const duplicate = migratedStore.createMany([
        {
          processName: 'proc',
          eventName: 'evt',
          payload: { a: 2 },
          idempotencyKey: 'dup-key',
        },
      ])

      expect(duplicate).toEqual([])

      migratedStore.close?.()
      try {
        fs.unlinkSync(dbPath)
      } catch {}
      try {
        fs.unlinkSync(dbPath + '-wal')
      } catch {}
      try {
        fs.unlinkSync(dbPath + '-shm')
      } catch {}
    })

    it('preserves singleton admission against legacy active runs', () => {
      const dbPath = path.join(os.tmpdir(), `run-sqlite-migration-singleton-${Date.now()}.db`)
      const legacyStore = createSqliteRunStore(dbPath)
      legacyStore.create('singleton-proc', 'evt', null)
      legacyStore.claimIdle(1, 'owner-1', 30_000)
      legacyStore.close?.()
      downgradeSchemaToV9(dbPath)

      const migratedStore = createSqliteRunStore(dbPath)
      const duplicate = migratedStore.createMany([
        {
          processName: 'singleton-proc',
          eventName: 'evt',
          payload: null,
          singleton: true,
        },
      ])

      expect(duplicate).toEqual([])

      migratedStore.close?.()
      try {
        fs.unlinkSync(dbPath)
      } catch {}
      try {
        fs.unlinkSync(dbPath + '-wal')
      } catch {}
      try {
        fs.unlinkSync(dbPath + '-shm')
      } catch {}
    })
  })
})
