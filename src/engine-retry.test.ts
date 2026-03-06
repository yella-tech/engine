import { describe, it, expect, afterEach } from 'vitest'
import { createEngine, EngineError, ErrorCode } from './index.js'
import type { EngineOptions } from './types.js'

// --- Retry / DLQ tests ---

function retryTests(label: string, opts: EngineOptions) {
  describe(`${label}, retry/DLQ`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('basic retry succeeds on second attempt', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 2, delay: 0 } })
      let calls = 0
      engine.register('proc', 'go', async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return { success: true, payload: 'ok' }
      })

      engine.emit('go', 'data')
      await engine.drain()

      const completed = engine.getCompleted()
      expect(completed).toHaveLength(1)
      const run = completed[0]
      expect(run.attempt).toBe(1)
      expect(run.result!.success).toBe(true)
    })

    it('retries exhaust → errored', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 2, delay: 0 } })
      engine.register('proc', 'go', async () => {
        throw new Error('always-fails')
      })

      engine.emit('go', 'data')
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      const run = errored[0]
      expect(run.attempt).toBe(2)
      expect(run.result!.error).toBe('always-fails')
    })

    it('retry with delay', { timeout: 10_000 }, async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 1, delay: 50 } })
      let calls = 0
      engine.register('proc', 'go', async () => {
        calls++
        if (calls === 1) throw new Error('transient')
        return { success: true }
      })

      engine.emit('go', 'data')

      // After first failure, run should be idle but not yet claimable
      await new Promise((r) => setTimeout(r, 10))
      const idle = engine.getIdle()
      expect(idle).toHaveLength(1)
      expect(idle[0].retryAfter).not.toBeNull()

      // Wait for the retry delay to expire and be picked up
      await engine.drain(5000)

      expect(engine.getCompleted()).toHaveLength(1)
    })

    it('no retry on { success: false }', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 3, delay: 0 } })
      engine.register('proc', 'go', async () => {
        return { success: false, error: 'permanent' }
      })

      engine.emit('go', 'data')
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      expect(errored[0].attempt).toBe(0)
      expect(errored[0].result!.error).toBe('permanent')
    })

    it('per-process retry overrides global', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 1, delay: 0 } })
      engine.register(
        'proc',
        'go',
        async () => {
          throw new Error('fail')
        },
        { retry: { maxRetries: 3, delay: 0 } },
      )

      engine.emit('go', 'data')
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      expect(errored[0].attempt).toBe(3) // per-process maxRetries=3, not global 1
    })

    it('onRetry hook fires on each retry', async () => {
      const retryLog: { error: string; attempt: number }[] = []
      engine = createEngine({
        ...opts,
        retry: { maxRetries: 2, delay: 0 },
        onRetry: (_run, error, attempt) => {
          retryLog.push({ error, attempt })
        },
      })
      engine.register('proc', 'go', async () => {
        throw new Error('oops')
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(retryLog).toHaveLength(2)
      expect(retryLog[0]).toEqual({ error: 'oops', attempt: 0 })
      expect(retryLog[1]).toEqual({ error: 'oops', attempt: 1 })
    })

    it('onDead hook fires when exhausted', async () => {
      const deadLog: { error: string }[] = []
      engine = createEngine({
        ...opts,
        retry: { maxRetries: 1, delay: 0 },
        onDead: (_run, error) => {
          deadLog.push({ error })
        },
      })
      engine.register('proc', 'go', async () => {
        throw new Error('fatal')
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(deadLog).toHaveLength(1)
      expect(deadLog[0].error).toBe('fatal')
    })

    it('context preserved across retries', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 1, delay: 0 } })
      let calls = 0
      engine.register('proc', 'go', async (ctx) => {
        calls++
        if (calls === 1) {
          ctx.setContext('progress', 50)
          throw new Error('transient')
        }
        // On retry, context from prior attempt should be available
        return { success: true, payload: ctx.context.progress }
      })

      engine.emit('go', 'data')
      await engine.drain()

      const completed = engine.getCompleted()
      expect(completed).toHaveLength(1)
      expect(completed[0].result!.payload).toBe(50)
      expect(completed[0].context.progress).toBe(50)
    })

    it('graceful stop does not wait for pending retries', async () => {
      engine = createEngine({ ...opts, retry: { maxRetries: 1, delay: 5000 } })
      engine.register('proc', 'go', async () => {
        throw new Error('transient')
      })

      engine.emit('go', 'data')
      // Wait for first failure and transition to idle with 5s delay
      await new Promise((r) => setTimeout(r, 50))

      // Graceful stop should resolve immediately (no active handlers, retry is just a pending setTimeout)
      const start = Date.now()
      await engine.stop({ graceful: true, timeoutMs: 1000 })
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(500)
    })
  })
}

retryTests('retry/DLQ (memory store)', {})
retryTests('retry/DLQ (sqlite :memory: store)', { store: { type: 'sqlite', path: ':memory:' } })

// --- Observability hook tests ---

function hookTests(label: string, opts: EngineOptions) {
  describe(`${label}, lifecycle hooks`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('onRunStart fires when handler begins', async () => {
      const started: string[] = []
      engine = createEngine({ ...opts, onRunStart: (run) => started.push(run.processName) })
      engine.register('proc', 'go', async () => ({ success: true }))

      engine.emit('go', 'data')
      await engine.drain()

      expect(started).toEqual(['proc'])
    })

    it('onRunFinish fires on completion', async () => {
      const finished: { name: string; state: string }[] = []
      engine = createEngine({ ...opts, onRunFinish: (run) => finished.push({ name: run.processName, state: run.state }) })
      engine.register('proc', 'go', async () => ({ success: true }))

      engine.emit('go', 'data')
      await engine.drain()

      expect(finished).toEqual([{ name: 'proc', state: 'completed' }])
    })

    it('onRunFinish fires on error', async () => {
      const finished: { name: string; state: string }[] = []
      engine = createEngine({ ...opts, onRunFinish: (run) => finished.push({ name: run.processName, state: run.state }) })
      engine.register('proc', 'go', async () => {
        throw new Error('fail')
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(finished).toEqual([{ name: 'proc', state: 'errored' }])
    })

    it('onRunError fires with error message on throw', async () => {
      const errors: { name: string; error: string }[] = []
      engine = createEngine({ ...opts, onRunError: (run, error) => errors.push({ name: run.processName, error }) })
      engine.register('proc', 'go', async () => {
        throw new Error('kaboom')
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(errors).toEqual([{ name: 'proc', error: 'kaboom' }])
    })

    it('onRunError fires on { success: false } return', async () => {
      const errors: string[] = []
      engine = createEngine({ ...opts, onRunError: (_run, error) => errors.push(error) })
      engine.register('proc', 'go', async () => ({ success: false, error: 'nope' }))

      engine.emit('go', 'data')
      await engine.drain()

      expect(errors).toEqual(['nope'])
    })

    it('onRunStart not called for pre-handler errors (schema validation)', async () => {
      const started: string[] = []
      const errors: string[] = []
      engine = createEngine({ ...opts, onRunStart: (run) => started.push(run.processName), onRunError: (_run, err) => errors.push(err) })
      engine.register(
        'proc',
        'go',
        {
          parse: () => {
            throw new Error('bad schema')
          },
        },
        async () => ({ success: true }),
      )

      engine.emit('go', 'data')
      await engine.drain()

      expect(started).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBe('bad schema')
    })

    it('all three hooks fire in order for successful run', async () => {
      const log: string[] = []
      engine = createEngine({
        ...opts,
        onRunStart: () => log.push('start'),
        onRunFinish: () => log.push('finish'),
        onRunError: () => log.push('error'),
      })
      engine.register('proc', 'go', async () => ({ success: true }))

      engine.emit('go', 'data')
      await engine.drain()

      expect(log).toEqual(['start', 'finish'])
    })

    it('all three hooks fire in order for errored run', async () => {
      const log: string[] = []
      engine = createEngine({
        ...opts,
        onRunStart: () => log.push('start'),
        onRunFinish: () => log.push('finish'),
        onRunError: () => log.push('error'),
      })
      engine.register('proc', 'go', async () => {
        throw new Error('fail')
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(log).toEqual(['start', 'error', 'finish'])
    })

    it('onRunStart fires per retry attempt, onRunFinish/onRunError only on terminal', async () => {
      const starts: number[] = []
      const finishes: string[] = []
      let calls = 0
      engine = createEngine({
        ...opts,
        retry: { maxRetries: 2, delay: 0 },
        onRunStart: (run) => starts.push(run.attempt),
        onRunFinish: (run) => finishes.push(run.state),
      })
      engine.register('proc', 'go', async () => {
        calls++
        if (calls <= 2) throw new Error('transient')
        return { success: true }
      })

      engine.emit('go', 'data')
      await engine.drain()

      expect(starts).toEqual([0, 1, 2]) // fired each attempt
      expect(finishes).toEqual(['completed']) // only terminal
    })
  })
}

hookTests('hooks (memory store)', {})
hookTests('hooks (sqlite :memory: store)', { store: { type: 'sqlite', path: ':memory:' } })

// --- Typed error tests ---

function errorTests(label: string, opts: EngineOptions) {
  describe(`${label}, EngineError codes`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('emit with oversized payload throws EngineError with PAYLOAD_TOO_LARGE', () => {
      engine = createEngine({ ...opts, maxPayloadBytes: 10 })
      engine.register('proc', 'go', async () => ({ success: true }))

      try {
        engine.emit('go', 'x'.repeat(100))
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError)
        expect((err as EngineError).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE)
      }
    })

    it('handler timeout sets HANDLER_TIMEOUT errorCode on result', async () => {
      engine = createEngine({ ...opts, handlerTimeoutMs: 20 })
      engine.register('proc', 'go', async () => {
        await new Promise((r) => setTimeout(r, 500))
        return { success: true }
      })

      engine.emit('go', null)
      await engine.drain(5000)

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      expect(errored[0].result!.errorCode).toBe(ErrorCode.HANDLER_TIMEOUT)
    })

    it('schema validation failure sets SCHEMA_VALIDATION_FAILED errorCode', async () => {
      engine = createEngine(opts)
      engine.register(
        'proc',
        'go',
        {
          parse: () => {
            throw new Error('invalid')
          },
        },
        async () => ({ success: true }),
      )

      engine.emit('go', 'data')
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      expect(errored[0].result!.errorCode).toBe(ErrorCode.SCHEMA_VALIDATION_FAILED)
    })

    it('result payload too large sets PAYLOAD_TOO_LARGE errorCode', async () => {
      engine = createEngine({ ...opts, maxPayloadBytes: 10 })
      engine.register('proc', 'go', async () => ({ success: true, payload: 'x'.repeat(100) }))

      engine.emit('go', 'ok')
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)
      expect(errored[0].result!.errorCode).toBe(ErrorCode.PAYLOAD_TOO_LARGE)
    })

    it('duplicate register throws EngineError with PROCESS_ALREADY_REGISTERED', () => {
      engine = createEngine(opts)
      engine.register('proc', 'go', async () => ({ success: true }))

      try {
        engine.register('proc', 'go', async () => ({ success: true }))
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError)
        expect((err as EngineError).code).toBe(ErrorCode.PROCESS_ALREADY_REGISTERED)
      }
    })

    it('drain timeout throws EngineError with DRAIN_TIMEOUT', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'go', async () => {
        await new Promise((r) => setTimeout(r, 5000))
        return { success: true }
      })
      engine.emit('go', null)

      try {
        await engine.drain(20)
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError)
        expect((err as EngineError).code).toBe(ErrorCode.DRAIN_TIMEOUT)
      }
    })

    it('handler error without EngineError has no errorCode on result', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'go', async () => {
        throw new Error('plain error')
      })

      engine.emit('go', null)
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored[0].result!.errorCode).toBeUndefined()
      expect(errored[0].result!.error).toBe('plain error')
    })
  })
}

errorTests('errors (memory store)', {})
errorTests('errors (sqlite :memory: store)', { store: { type: 'sqlite', path: ':memory:' } })
