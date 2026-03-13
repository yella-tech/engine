import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createRunStore } from './run.js'
import type { RunStore } from './types.js'

describe('createRunStore (memory)', () => {
  let store: RunStore

  beforeEach(() => {
    store = createRunStore()
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

    it('returns detached runs so external mutation cannot alter stored state', () => {
      const created = store.create('proc', 'event', { nested: { x: 1 } })
      created.state = 'completed'
      ;(created.payload as any).nested.x = 999

      const fresh = store.get(created.id)!
      expect(fresh.state).toBe('idle')
      expect((fresh.payload as any).nested.x).toBe(1)
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
  })

  describe('get', () => {
    it('returns null for unknown id', () => {
      expect(store.get('nope')).toBeNull()
    })

    it('returns detached copies so edits to fetched runs do not mutate the store', () => {
      const run = store.create('proc', 'event', { count: 1 })
      const fetched = store.get(run.id)!
      fetched.state = 'completed'
      ;(fetched.payload as any).count = 999

      const fresh = store.get(run.id)!
      expect(fresh.state).toBe('idle')
      expect((fresh.payload as any).count).toBe(1)
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
    })
  })

  describe('heartbeat', () => {
    it('extends leaseExpiresAt for matching owner', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      const newExpiry = Date.now() + 60_000
      store.heartbeat(run.id, 'owner-1', newExpiry)
      const updated = store.get(run.id)!
      expect(updated.leaseExpiresAt).toBe(newExpiry)
      expect(updated.heartbeatAt).toBeGreaterThan(0)
    })

    it('is no-op for wrong owner', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      const originalExpiry = run.leaseExpiresAt
      store.heartbeat(run.id, 'wrong-owner', Date.now() + 60_000)
      const updated = store.get(run.id)!
      expect(updated.leaseExpiresAt).toBe(originalExpiry)
    })

    it('is no-op for non-running run', () => {
      store.create('proc', 'event', null)
      const claimed = store.claimIdle(1, 'owner-1', 30_000)
      const run = claimed[0]
      store.transition(run.id, 'completed')
      store.heartbeat(run.id, 'owner-1', Date.now() + 60_000)
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

      vi.advanceTimersByTime(31_000) // advance past lease expiry

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

      vi.advanceTimersByTime(10_000) // only 10s, still 50s left on lease

      const reclaimed = store.reclaimStale()
      expect(reclaimed).toHaveLength(0)
    })

    it('ignores idle/completed runs', () => {
      store.create('proc', 'event', null)
      // run is idle, should not be reclaimed
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
})
