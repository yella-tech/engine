import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'
import type { Engine, EngineEvent, EngineOptions } from './types.js'

function observabilityTests(label: string, storeOpts: EngineOptions) {
  describe(`observability (${label})`, () => {
    let engine: Engine
    const events: EngineEvent[] = []

    function setup(extra?: Partial<EngineOptions>) {
      events.length = 0
      engine = createEngine({ ...storeOpts, ...extra, onEvent: (e) => events.push(e) })
    }

    afterEach(async () => {
      await engine?.stop()
    })

    it('emits run:start and run:complete with durationMs', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      const starts = events.filter((e) => e.type === 'run:start')
      const completes = events.filter((e) => e.type === 'run:complete')
      expect(starts).toHaveLength(1)
      expect(completes).toHaveLength(1)
      expect(completes[0].type === 'run:complete' && completes[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits run:error with durationMs on handler failure', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: false, error: 'boom' }))
      engine.emit('go', {})
      await engine.drain()

      const errors = events.filter((e) => e.type === 'run:error')
      expect(errors).toHaveLength(1)
      expect(errors[0].type === 'run:error' && errors[0].error).toBe('boom')
      expect(errors[0].type === 'run:error' && errors[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits run:error with durationMs on thrown error', async () => {
      setup()
      engine.register('proc', 'go', async () => {
        throw new Error('kaboom')
      })
      engine.emit('go', {})
      await engine.drain()

      const errors = events.filter((e) => e.type === 'run:error')
      expect(errors).toHaveLength(1)
      expect(errors[0].type === 'run:error' && errors[0].error).toBe('kaboom')
      expect(errors[0].type === 'run:error' && errors[0].durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits run:retry on retryable failure', async () => {
      setup()
      let attempt = 0
      engine.register('proc', 'go', async () => {
        attempt++
        if (attempt === 1) throw new Error('fail')
        return { success: true }
      }, { retry: { maxRetries: 2, delay: 0 } })
      engine.emit('go', {})
      await engine.drain()

      const retries = events.filter((e) => e.type === 'run:retry')
      expect(retries).toHaveLength(1)
      expect(retries[0].type === 'run:retry' && retries[0].attempt).toBe(0)
    })

    it('emits run:dead then run:error when retries exhausted', async () => {
      setup()
      engine.register('proc', 'go', async () => {
        throw new Error('always fails')
      }, { retry: { maxRetries: 1, delay: 0 } })
      engine.emit('go', {})
      await engine.drain()

      const retries = events.filter((e) => e.type === 'run:retry')
      const deads = events.filter((e) => e.type === 'run:dead')
      const errors = events.filter((e) => e.type === 'run:error')
      expect(retries).toHaveLength(1)
      expect(deads).toHaveLength(1)
      expect(errors).toHaveLength(1)
      // run:dead fires before run:error
      const deadIdx = events.indexOf(deads[0])
      const errorIdx = events.indexOf(errors[0])
      expect(deadIdx).toBeLessThan(errorIdx)
    })

    it('emits run:resume on deferred run resume', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next', deferred: true }))
      engine.register('step2', 'next', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
      engine.resume(deferred.id)
      await engine.drain()

      const resumes = events.filter((e) => e.type === 'run:resume')
      expect(resumes).toHaveLength(1)
      if (resumes[0].type === 'run:resume') {
        expect(resumes[0].resumedRun.id).toBe(deferred.id)
        expect(resumes[0].childRuns.length).toBeGreaterThanOrEqual(1)
        expect(resumes[0].resumedRun.result?.deferred).toBe(false)
        expect(resumes[0].resumedRun.childRunIds).toHaveLength(resumes[0].childRuns.length)
        expect(resumes[0].resumedRun.childRunIds).toContain(resumes[0].childRuns[0].id)
      }
    })

    it('emits effect:complete with durationMs', async () => {
      setup()
      engine.register('proc', 'go', async (ctx) => {
        await ctx.effect('my-effect', async () => 'result')
        return { success: true }
      })
      engine.emit('go', {})
      await engine.drain()

      const effectCompletes = events.filter((e) => e.type === 'effect:complete')
      expect(effectCompletes).toHaveLength(1)
      if (effectCompletes[0].type === 'effect:complete') {
        expect(effectCompletes[0].effectKey).toBe('my-effect')
        expect(effectCompletes[0].durationMs).toBeGreaterThanOrEqual(0)
      }
    })

    it('emits effect:error with durationMs on effect failure', async () => {
      setup()
      engine.register('proc', 'go', async (ctx) => {
        await ctx.effect('bad-effect', async () => {
          throw new Error('effect boom')
        })
        return { success: true }
      })
      engine.emit('go', {})
      await engine.drain()

      const effectErrors = events.filter((e) => e.type === 'effect:error')
      expect(effectErrors).toHaveLength(1)
      if (effectErrors[0].type === 'effect:error') {
        expect(effectErrors[0].effectKey).toBe('bad-effect')
        expect(effectErrors[0].error).toBe('effect boom')
        expect(effectErrors[0].durationMs).toBeGreaterThanOrEqual(0)
      }
    })

    it('emits effect:replay on retry with completed effect', async () => {
      setup()
      let callCount = 0
      engine.register('proc', 'go', async (ctx) => {
        await ctx.effect('idempotent', async () => {
          callCount++
          return 'done'
        })
        if (callCount === 1) throw new Error('first attempt fails')
        return { success: true }
      }, { retry: { maxRetries: 1, delay: 0 } })
      engine.emit('go', {})
      await engine.drain()

      const replays = events.filter((e) => e.type === 'effect:replay')
      expect(replays).toHaveLength(1)
      if (replays[0].type === 'effect:replay') {
        expect(replays[0].effectKey).toBe('idempotent')
      }
    })

    it('fires legacy hooks alongside onEvent', async () => {
      const legacyStarts: string[] = []
      const legacyFinishes: string[] = []
      setup({
        onRunStart: (run) => legacyStarts.push(run.id),
        onRunFinish: (run) => legacyFinishes.push(run.id),
      })
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      expect(legacyStarts).toHaveLength(1)
      expect(legacyFinishes).toHaveLength(1)
      expect(events.filter((e) => e.type === 'run:start')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'run:complete')).toHaveLength(1)
    })

    it('emits internal:error for swallowed legacy hook failures', async () => {
      const internalErrors: string[] = []
      setup({
        onRunStart: () => {
          throw new Error('hook blew up')
        },
        onInternalError: (_err, ctx) => internalErrors.push(ctx),
      })
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      const internalEvents = events.filter((e) => e.type === 'internal:error')
      expect(internalErrors).toContain('onRunStart')
      expect(internalEvents).toHaveLength(1)
      if (internalEvents[0].type === 'internal:error') {
        expect(internalEvents[0].context).toBe('onRunStart')
      }
      expect(engine.getMetrics().totals.internalErrors).toBe(1)
    })

    it('onEvent failure does not break engine', async () => {
      const internalErrors: string[] = []
      engine = createEngine({
        ...storeOpts,
        onEvent: () => {
          throw new Error('observer crash')
        },
        onInternalError: (_err, ctx) => internalErrors.push(ctx),
      })
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      expect(engine.getCompleted()).toHaveLength(1)
      expect(internalErrors).toContain('onEvent')
    })

    it('getMetrics returns queue snapshot and runtime totals', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', { a: 1 })
      engine.emit('go', { a: 2 })
      await engine.drain()

      const metrics = engine.getMetrics()
      expect(metrics.queue.completed).toBe(2)
      expect(metrics.queue.idle).toBe(0)
      expect(metrics.queue.running).toBe(0)
      expect(metrics.queue.errored).toBe(0)
      expect(metrics.totals.retries).toBe(0)
      expect(metrics.totals.deadLetters).toBe(0)
    })

    it('getMetrics tracks retry and dead-letter totals', async () => {
      setup()
      engine.register('proc', 'go', async () => {
        throw new Error('always fails')
      }, { retry: { maxRetries: 2, delay: 0 } })
      engine.emit('go', {})
      await engine.drain()

      const metrics = engine.getMetrics()
      expect(metrics.totals.retries).toBe(2)
      expect(metrics.totals.deadLetters).toBe(1)
      expect(metrics.queue.errored).toBe(1)
    })

    it('getMetrics tracks resume totals', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next', deferred: true }))
      engine.register('step2', 'next', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
      engine.resume(deferred.id)
      await engine.drain()

      const metrics = engine.getMetrics()
      expect(metrics.totals.resumes).toBe(1)
    })

    it('getMetrics returns a copy (not a reference)', async () => {
      setup()
      const m1 = engine.getMetrics()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()
      const m2 = engine.getMetrics()

      expect(m1.queue.completed).toBe(0)
      expect(m2.queue.completed).toBe(1)
    })
  })
}

observabilityTests('memory', {})
observabilityTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
