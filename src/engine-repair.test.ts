import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'
import { createRunStore } from './run.js'
import { getRunStatus } from './status.js'
import type { EngineOptions } from './types.js'

// ── Graceful stop ──

function gracefulStopTests(label: string, opts: EngineOptions) {
  describe(`graceful stop (${label})`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(async () => {
      try {
        await engine?.stop()
      } catch {
        /* may already be stopped */
      }
    })

    it('waits for in-flight handlers to finish', async () => {
      engine = createEngine({ ...opts, concurrency: 1 })
      let handlerFinished = false
      engine.register('slow', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 50))
        handlerFinished = true
        return { success: true, payload: 'done' }
      })

      engine.emit('evt', null)
      // Let the dispatcher claim the run
      await new Promise((r) => setTimeout(r, 5))

      await engine.stop({ graceful: true, timeoutMs: 5000 })

      expect(handlerFinished).toBe(true)
    })

    it('timeout rejects when handler takes too long', async () => {
      engine = createEngine({ ...opts, concurrency: 1 })
      engine.register('forever', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 5000))
        return { success: true }
      })

      engine.emit('evt', null)
      await new Promise((r) => setTimeout(r, 5))

      await expect(engine.stop({ graceful: true, timeoutMs: 50 })).rejects.toThrow('graceful stop timed out after 50ms')
    })

    it('hard stop (default) does not wait', async () => {
      engine = createEngine({ ...opts, concurrency: 1 })
      let finished = false
      engine.register('slow', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 100))
        finished = true
        return { success: true }
      })

      engine.emit('evt', null)
      await new Promise((r) => setTimeout(r, 5))

      await engine.stop()
      expect(finished).toBe(false)
    })
  })
}

gracefulStopTests('memory', {})
gracefulStopTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

// ── Repair APIs ──

describe('repair APIs', () => {
  let engine: ReturnType<typeof createEngine>

  afterEach(async () => {
    await engine?.stop()
  })

  it('retryRun: errored -> idle, increments attempt, timeline entry', async () => {
    engine = createEngine({ retry: { maxRetries: 0, delay: 0 } })
    let callCount = 0
    engine.register('proc', 'evt', async () => {
      callCount++
      if (callCount === 1) throw new Error('fail')
      return { success: true }
    })
    const [run] = engine.emit('evt', null)
    await engine.drain()

    const errored = engine.getRun(run.id)!
    expect(errored.state).toBe('errored')

    const retried = engine.retryRun(run.id)
    expect(retried.state).toBe('idle')
    expect(retried.result).toBeNull()
    expect(retried.completedAt).toBeNull()
    const lastEntry = retried.timeline[retried.timeline.length - 1]
    expect(lastEntry.error).toBe('manual retry')

    await engine.drain()
    const completed = engine.getRun(run.id)!
    expect(completed.state).toBe('completed')
    expect(callCount).toBe(2)
  })

  it('retryRun: throws for non-errored run', () => {
    engine = createEngine({ concurrency: 0 })
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = engine.emit('evt', null)
    expect(() => engine.retryRun(run.id)).toThrow('Cannot retry run in state: idle')
  })

  it('requeueDead: errored -> idle, resets attempt to 0', async () => {
    engine = createEngine({ retry: { maxRetries: 1, delay: 0 } })
    engine.register('proc', 'evt', async () => {
      throw new Error('fail')
    })
    const [run] = engine.emit('evt', null)
    await engine.drain()

    const errored = engine.getRun(run.id)!
    expect(errored.state).toBe('errored')
    expect(errored.attempt).toBeGreaterThan(0)
    expect(getRunStatus(errored)).toBe('dead-letter')

    const requeued = engine.requeueDead(run.id)
    expect(requeued.state).toBe('idle')
    expect(requeued.result).toBeNull()
    expect(requeued.completedAt).toBeNull()
    // Check attempt was reset (the run from transition won't show 0 directly
    // since transition doesn't change attempt, but resetAttempt was called before)
    const fresh = engine.getRun(run.id)!
    expect(fresh.attempt).toBe(0)
  })

  it('requeueDead: throws for non-dead-letter errored run', async () => {
    engine = createEngine()
    engine.register('proc', 'evt', async () => ({ success: false, error: 'plain error' }))
    const [run] = engine.emit('evt', null)
    await engine.drain()

    expect(() => engine.requeueDead(run.id)).toThrow('Cannot requeue run in status: errored')
  })

  it('cancelRun: idle -> errored with cancelled error', () => {
    engine = createEngine({ concurrency: 0 })
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = engine.emit('evt', null)

    const cancelled = engine.cancelRun(run.id)
    expect(cancelled.state).toBe('errored')
    expect(cancelled.result!.error).toBe('cancelled')
    const lastEntry = cancelled.timeline[cancelled.timeline.length - 1]
    expect(lastEntry.error).toBe('cancelled')
  })

  it('cancelRun: throws for completed run', async () => {
    engine = createEngine()
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = await engine.emitAndWait('evt', null)
    expect(() => engine.cancelRun(run.id)).toThrow('Cannot cancel run in state: completed')
  })

  it('cancelRun fences late context and effect writes from a running handler', async () => {
    engine = createEngine()
    let effectCalls = 0
    engine.register('proc', 'evt', async (ctx) => {
      await new Promise((r) => setTimeout(r, 25))
      try {
        ctx.setContext('late', true)
      } catch {}
      try {
        await ctx.effect('late-effect', () => {
          effectCalls++
          return { ok: true }
        })
      } catch {}
      await new Promise((r) => setTimeout(r, 25))
      return { success: true }
    })

    const [run] = engine.emit('evt', null)
    await new Promise((r) => setTimeout(r, 5))
    const cancelled = engine.cancelRun(run.id)

    expect(cancelled.state).toBe('errored')
    await new Promise((r) => setTimeout(r, 80))

    const after = engine.getRun(run.id)!
    expect(after.context.late).toBeUndefined()
    expect(engine.getEffects(run.id)).toHaveLength(0)
    expect(effectCalls).toBe(0)
    expect(after.result!.error).toBe('cancelled')
  })
})

// ── Handler version ──

describe('handler version', () => {
  let engine: ReturnType<typeof createEngine>

  afterEach(async () => {
    await engine?.stop()
  })

  it('version stamped on run when registered with version', async () => {
    engine = createEngine()
    engine.register('proc', 'evt', async () => ({ success: true }), { version: '1.2.0' })
    const [run] = await engine.emitAndWait('evt', null)
    const finished = engine.getRun(run.id)!
    expect(finished.handlerVersion).toBe('1.2.0')
  })

  it('handlerVersion is null when no version registered', async () => {
    engine = createEngine()
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = await engine.emitAndWait('evt', null)
    const finished = engine.getRun(run.id)!
    expect(finished.handlerVersion).toBeNull()
  })
})

// ── Invariants ──

describe('invariants', () => {
  let engine: ReturnType<typeof createEngine>

  afterEach(async () => {
    await engine?.stop()
  })

  it('completed runs cannot be transitioned', async () => {
    engine = createEngine()
    engine.register('proc', 'evt', async () => ({ success: true }))
    const [run] = await engine.emitAndWait('evt', null)
    const completed = engine.getRun(run.id)!
    expect(completed.state).toBe('completed')
    // Direct store access not available, but we can verify cancelRun rejects
    expect(() => engine.cancelRun(run.id)).toThrow('Cannot cancel run in state: completed')
    // retryRun also rejects
    expect(() => engine.retryRun(run.id)).toThrow('Cannot retry run in state: completed')
    // requeueDead also rejects
    expect(() => engine.requeueDead(run.id)).toThrow('Cannot requeue run in status: completed')
  })

  it('errored runs can only transition to idle (via repair)', async () => {
    engine = createEngine({ retry: { maxRetries: 0, delay: 0 } })
    engine.register('proc', 'evt', async () => {
      throw new Error('fail')
    })
    const [run] = engine.emit('evt', null)
    await engine.drain()
    const errored = engine.getRun(run.id)!
    expect(errored.state).toBe('errored')
    // retryRun works (errored -> idle)
    const retried = engine.retryRun(run.id)
    expect(retried.state).toBe('idle')
  })

  it('no work processed after stop()', async () => {
    engine = createEngine({ concurrency: 0 }) // concurrency 0 means no auto-processing
    engine.register('proc', 'evt', async () => ({ success: true }))
    engine.emit('evt', null)
    engine.emit('evt', null)
    engine.emit('evt', null)
    await engine.stop()
    // After stop, all runs should still be idle (none processed)
    // We can't query after stop since store may be closed
    // Instead, verify that emit returns empty after stop
    const result = engine.emit('evt', null)
    expect(result).toEqual([])
  })

  it('hard stop fences late engine-mediated writes from active handlers', async () => {
    engine = createEngine()
    let effectCalls = 0
    engine.register('proc', 'evt', async (ctx) => {
      await new Promise((r) => setTimeout(r, 25))
      try {
        ctx.setContext('late', true)
      } catch {}
      try {
        await ctx.effect('late-effect', () => {
          effectCalls++
          return { ok: true }
        })
      } catch {}
      return { success: true }
    })

    const [run] = engine.emit('evt', null)
    await new Promise((r) => setTimeout(r, 5))
    await engine.stop()
    await new Promise((r) => setTimeout(r, 80))

    expect(effectCalls).toBe(0)
    expect(engine.emit('evt', null)).toEqual([])
    expect(() => engine.getRun(run.id)).not.toThrow()
  })

  it('all invalid transitions are rejected by the store', () => {
    // Test the state machine exhaustively using the in-memory store directly
    const store = createRunStore()

    // idle -> can go to running (valid) but NOT completed or errored directly
    // Wait, with repair APIs: idle -> running is valid, idle -> errored is valid (cancel)
    // Let's verify the actual VALID_TRANSITIONS
    const run1 = store.create('p', 'e', null)

    // idle -> completed is invalid
    expect(() => store.transition(run1.id, 'completed')).toThrow('Invalid transition')

    // Create another run and get it to running
    const run2 = store.create('p', 'e', null)
    store.transition(run2.id, 'running')

    // running -> idle is valid (retry path), should NOT throw
    store.transition(run2.id, 'idle')

    // Create another, complete it
    const run3 = store.create('p', 'e', null)
    store.transition(run3.id, 'running')
    store.transition(run3.id, 'completed')

    // completed -> anything is invalid
    expect(() => store.transition(run3.id, 'idle')).toThrow('Invalid transition')
    expect(() => store.transition(run3.id, 'running')).toThrow('Invalid transition')
    expect(() => store.transition(run3.id, 'errored')).toThrow('Invalid transition')

    // Create another, error it
    const run4 = store.create('p', 'e', null)
    store.transition(run4.id, 'running')
    store.transition(run4.id, 'errored')

    // errored -> idle is valid (repair), but running/completed are invalid
    expect(() => store.transition(run4.id, 'running')).toThrow('Invalid transition')
    expect(() => store.transition(run4.id, 'completed')).toThrow('Invalid transition')
    // errored -> idle works
    store.transition(run4.id, 'idle')
  })
})
