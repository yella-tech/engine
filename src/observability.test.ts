import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

    it('supports direct event subscriptions for live invalidation', async () => {
      setup()
      const seen: EngineEvent[] = []
      const unsubscribe = engine.subscribeEvents((event) => seen.push(event))
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()
      unsubscribe()

      expect(seen.some((event) => event.type === 'run:start')).toBe(true)
      expect(seen.some((event) => event.type === 'run:complete')).toBe(true)
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
      engine.register(
        'proc',
        'go',
        async () => {
          attempt++
          if (attempt === 1) throw new Error('fail')
          return { success: true }
        },
        { retry: { maxRetries: 2, delay: 0 } },
      )
      engine.emit('go', {})
      await engine.drain()

      const retries = events.filter((e) => e.type === 'run:retry')
      expect(retries).toHaveLength(1)
      expect(retries[0].type === 'run:retry' && retries[0].attempt).toBe(0)
    })

    it('emits run:dead then run:error when retries exhausted', async () => {
      setup()
      engine.register(
        'proc',
        'go',
        async () => {
          throw new Error('always fails')
        },
        { retry: { maxRetries: 1, delay: 0 } },
      )
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
      engine.register(
        'proc',
        'go',
        async (ctx) => {
          await ctx.effect('idempotent', async () => {
            callCount++
            return 'done'
          })
          if (callCount === 1) throw new Error('first attempt fails')
          return { success: true }
        },
        { retry: { maxRetries: 1, delay: 0 } },
      )
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
      engine.register(
        'proc',
        'go',
        async () => {
          throw new Error('always fails')
        },
        { retry: { maxRetries: 2, delay: 0 } },
      )
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

    it('getObservability returns bucketed counts, latency, and recent errors', async () => {
      setup()
      engine.register('ok', 'ok', async (ctx) => {
        await ctx.effect('effect-ok', async () => 'done')
        return { success: true }
      })
      engine.register('bad', 'bad', async () => ({ success: false, error: 'boom' }))

      engine.emit('ok', {})
      engine.emit('bad', {})
      await engine.drain()

      const report = engine.getObservability({ from: Date.now() - 60_000, to: Date.now() + 1_000, bucketMs: 5 * 60_000 })

      expect(report.summary.runs.started).toBe(2)
      expect(report.summary.runs.completed).toBe(1)
      expect(report.summary.runs.failed).toBe(1)
      expect(report.summary.effects.completed).toBe(1)
      expect(report.summary.effects.failed).toBe(0)
      expect(report.summary.runs.duration.count).toBe(2)
      expect(report.summary.effects.duration.count).toBe(1)
      expect(report.buckets.length).toBeGreaterThanOrEqual(1)
      expect(report.recentErrors).toHaveLength(1)
      expect(report.recentErrors[0].kind).toBe('run')
      expect(report.recentErrors[0].message).toBe('boom')
    })

    it('getObservability backfills empty buckets across the requested window', async () => {
      setup()
      engine.register('ok', 'ok', async () => ({ success: true }))

      engine.emit('ok', {})
      await engine.drain()

      const now = Date.now()
      const report = engine.getObservability({ from: now - 10 * 60_000, to: now + 10 * 60_000, bucketMs: 5 * 60_000 })

      expect(report.buckets).toHaveLength(5)
      expect(report.buckets.some((bucket) => bucket.runs.started === 0)).toBe(true)
      expect(report.summary.runs.started).toBe(1)
    })

    it('getObservability captures effect and internal errors', async () => {
      setup({
        onRunStart: () => {
          throw new Error('hook blew up')
        },
      })
      engine.register('bad-effect', 'go', async (ctx) => {
        await ctx.effect('explode', async () => {
          throw new Error('effect boom')
        })
        return { success: true }
      })

      engine.emit('go', {})
      await engine.drain()

      const report = engine.getObservability({ from: Date.now() - 60_000, to: Date.now() + 1_000, bucketMs: 5 * 60_000 })
      const kinds = new Set(report.recentErrors.map((error) => error.kind))

      expect(report.summary.effects.failed).toBe(1)
      expect(report.summary.system.internalErrors).toBeGreaterThanOrEqual(1)
      expect(kinds.has('effect')).toBe(true)
      expect(kinds.has('internal')).toBe(true)
    })
  })
}

observabilityTests('memory', {})
observabilityTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

describe('observability persistence (sqlite)', () => {
  let tmpFile: string

  afterEach(() => {
    if (!tmpFile) return
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

  it('persists rollups across engine restarts', async () => {
    tmpFile = path.join(os.tmpdir(), `engine-observability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

    const engine1 = createEngine({ store: { type: 'sqlite', path: tmpFile } })
    engine1.register('proc', 'go', async (ctx) => {
      await ctx.effect('persisted', async () => 'done')
      return { success: true }
    })
    engine1.emit('go', {})
    await engine1.drain()
    const before = engine1.getObservability()
    await engine1.stop()

    const engine2 = createEngine({ store: { type: 'sqlite', path: tmpFile } })
    const after = engine2.getObservability()

    expect(after.summary.runs.completed).toBe(before.summary.runs.completed)
    expect(after.summary.effects.completed).toBe(before.summary.effects.completed)
    expect(after.buckets.length).toBeGreaterThanOrEqual(1)

    await engine2.stop()
  })
})
