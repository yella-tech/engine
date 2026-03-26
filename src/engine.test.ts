import { describe, it, expect, afterEach } from 'vitest'
import { createEngine, ErrorCode } from './index.js'
import type { EngineOptions } from './types.js'

function engineTests(label: string, opts: EngineOptions) {
  describe(label, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('emit + drain: runs complete, all states correct', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'go', async () => ({ success: true, payload: 'ok' }))
      const runs = engine.emit('go', 'data')
      expect(runs).toHaveLength(1)

      await engine.drain()

      const completed = engine.getCompleted()
      expect(completed).toHaveLength(1)
      expect(completed[0].result!.success).toBe(true)
    })

    it('invalid retention config throws INVALID_CONFIG', () => {
      expect(() => createEngine({ ...opts, retention: 'later' })).toThrow('retention')
    })

    it('event chain: parent triggers children, all share correlationId', async () => {
      engine = createEngine(opts)
      engine.register('triage', 'ticket', async () => ({
        success: true,
        triggerEvent: 'triaged',
        payload: { priority: 'high' },
      }))
      engine.register('notify', 'triaged', async () => ({ success: true }))
      engine.register('log', 'triaged', async () => ({ success: true }))

      const [root] = engine.emit('ticket', { id: 1 })
      await engine.drain()

      const chain = engine.getChain(root.id)
      expect(chain).toHaveLength(3) // triage + notify + log

      const correlationIds = new Set(chain.map((r) => r.correlationId))
      expect(correlationIds.size).toBe(1) // all share same correlationId

      expect(engine.getCompleted()).toHaveLength(3)
    })

    it('error handling: throwing handler errored, does not block other runs', async () => {
      engine = createEngine(opts)
      engine.register('good', 'evt', async () => ({ success: true }))
      engine.register('bad', 'evt', async () => {
        throw new Error('fail')
      })

      engine.emit('evt', null)
      await engine.drain()

      const completed = engine.getCompleted()
      const errored = engine.getErrored()
      expect(completed).toHaveLength(1)
      expect(errored).toHaveLength(1)
      expect(errored[0].result!.error).toBe('fail')
    })

    it('concurrency: verify max concurrent with concurrency=2', async () => {
      engine = createEngine({ ...opts, concurrency: 2 })

      let active = 0
      let maxActive = 0

      for (let i = 0; i < 10; i++) {
        engine.register(`proc-${i}`, `evt-${i}`, async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((r) => setTimeout(r, 10))
          active--
          return { success: true }
        })
      }

      for (let i = 0; i < 10; i++) engine.emit(`evt-${i}`, i)
      await engine.drain()

      expect(maxActive).toBe(2)
      expect(engine.getCompleted()).toHaveLength(10)
    })

    it('getChain returns full parent-child tree', async () => {
      engine = createEngine(opts)
      engine.register('step1', 'start', async () => ({
        success: true,
        triggerEvent: 'middle',
      }))
      engine.register('step2', 'middle', async () => ({
        success: true,
        triggerEvent: 'end',
      }))
      engine.register('step3', 'end', async () => ({ success: true }))

      const [root] = engine.emit('start', null)
      await engine.drain()

      const chain = engine.getChain(root.id)
      expect(chain).toHaveLength(3)
      expect(chain[0].id).toBe(root.id)
    })

    it('getRun returns null for unknown id', () => {
      engine = createEngine(opts)
      expect(engine.getRun('nonexistent')).toBeNull()
    })

    it('getIdle/getRunning/getCompleted/getErrored filter correctly', async () => {
      engine = createEngine(opts)
      engine.register('ok', 'evt', async () => ({ success: true }))
      engine.register('fail', 'evt', async () => ({ success: false, error: 'nope' }))

      engine.emit('evt', null)
      await engine.drain()

      expect(engine.getIdle()).toHaveLength(0)
      expect(engine.getRunning()).toHaveLength(0)
      expect(engine.getCompleted()).toHaveLength(1)
      expect(engine.getErrored()).toHaveLength(1)
    })

    it('stop: closes store, no more processing', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true }))
      engine.emit('evt', null)
      await engine.drain()

      expect(engine.getCompleted()).toHaveLength(1)
      // stop() should not throw
      engine.stop()
    })

    it('emit/emitAndWait are no-ops after stop', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true }))

      await engine.stop()

      const emitted = engine.emit('evt', null)
      const emittedAndWait = await engine.emitAndWait('evt', null)
      expect(emitted).toEqual([])
      expect(emittedAndWait).toEqual([])
    })

    it('drain timeout: rejects if work does not complete in time', async () => {
      engine = createEngine(opts)
      engine.register('slow', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 5000))
        return { success: true }
      })
      engine.emit('evt', null)

      await expect(engine.drain(50)).rejects.toThrow('drain timed out')
    })

    it('context propagation: parent setContext visible in child run context', async () => {
      engine = createEngine(opts)
      engine.register('parent', 'start', async (ctx) => {
        ctx.setContext('fromParent', 'hello')
        return { success: true, triggerEvent: 'child', payload: null }
      })
      engine.register('child', 'child', async (ctx) => {
        // Child should see parent context
        return { success: true, payload: ctx.context.fromParent }
      })

      const [root] = engine.emit('start', null)
      await engine.drain()

      const chain = engine.getChain(root.id)
      const childRun = chain.find((r) => r.processName === 'child')!
      expect(childRun.context.fromParent).toBe('hello')
      expect(childRun.result!.payload).toBe('hello')
    })

    it('context deep-copied: nested mutation does not leak into store', async () => {
      engine = createEngine(opts)
      engine.register('parent', 'start', async (ctx) => {
        ctx.setContext('nested', { count: 0 })
        return { success: true, triggerEvent: 'child', payload: null }
      })
      engine.register('child', 'child', async (ctx) => {
        // Mutate nested object directly (not via setContext)
        ;(ctx.context.nested as { count: number }).count = 999
        return { success: true }
      })

      const [root] = engine.emit('start', null)
      await engine.drain()

      // The stored context should be unaffected by the direct mutation
      const parentRun = engine.getRun(root.id)!
      expect(parentRun.context.nested).toEqual({ count: 0 })
      const chain = engine.getChain(root.id)
      const childRun = chain.find((r) => r.processName === 'child')!
      expect(childRun.context.nested).toEqual({ count: 0 })
    })

    it('schema parse output is passed to handler payload', async () => {
      engine = createEngine(opts)
      engine.register(
        'proc',
        'evt',
        {
          parse(data: unknown) {
            if (typeof data !== 'string') throw new Error('Expected string')
            return Number(data)
          },
        },
        async (ctx) => {
          return { success: true, payload: { value: ctx.payload, type: typeof ctx.payload } }
        },
      )

      engine.emit('evt', '42')
      await engine.drain()

      const completed = engine.getCompleted()
      expect(completed).toHaveLength(1)
      expect(completed[0].result!.payload).toEqual({ value: 42, type: 'number' })
    })

    it('concurrency-limited process: skips events while first is active', async () => {
      engine = createEngine(opts)
      engine.register(
        'proc',
        'evt',
        async () => {
          await new Promise((r) => setTimeout(r, 50))
          return { success: true }
        },
        { concurrency: 1 },
      )

      const runs1 = engine.emit('evt', null)
      const runs2 = engine.emit('evt', null) // should be skipped

      expect(runs1).toHaveLength(1)
      expect(runs2).toHaveLength(0)

      await engine.drain()
    })

    describe('process() API', () => {
      it('basic process with ok() return', async () => {
        engine = createEngine(opts)
        engine.process({
          name: 'greet',
          on: 'user.signup',
          run: (ctx) => ctx.ok({ welcomed: true }),
        })
        engine.emit('user.signup', { name: 'Alice' })
        await engine.drain()

        const completed = engine.getCompleted()
        expect(completed).toHaveLength(1)
        expect(completed[0].result).toEqual({ success: true, payload: { welcomed: true } })
      })

      it('ok(payload, { emit }) chains to next event', async () => {
        engine = createEngine(opts)
        engine.process({
          name: 'triage',
          on: 'ticket.new',
          run: (ctx) => ctx.ok({ priority: 'high' }, { emit: 'ticket.triaged' }),
        })
        engine.process({
          name: 'notify',
          on: 'ticket.triaged',
          run: (ctx) => ctx.ok(),
        })

        const [root] = engine.emit('ticket.new', { id: 1 })
        await engine.drain()

        const chain = engine.getChain(root.id)
        expect(chain).toHaveLength(2)
        expect(chain[0].result).toEqual({ success: true, payload: { priority: 'high' }, triggerEvent: 'ticket.triaged' })
        expect(chain[1].result).toEqual({ success: true })
      })

      it('fail() with error and code', async () => {
        engine = createEngine(opts)
        engine.process({
          name: 'validate',
          on: 'data.check',
          run: (ctx) => ctx.fail('bad payload', ErrorCode.SCHEMA_VALIDATION_FAILED),
        })
        engine.emit('data.check', {})
        await engine.drain()

        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result).toEqual({
          success: false,
          error: 'bad payload',
          errorCode: ErrorCode.SCHEMA_VALIDATION_FAILED,
        })
      })

      it('effect with string key', async () => {
        engine = createEngine(opts)
        let callCount = 0
        engine.process({
          name: 'send-email',
          on: 'notify',
          run: async (ctx) => {
            const result = await ctx.effect({
              key: 'send',
              run: () => {
                callCount++
                return 'sent'
              },
            })
            return ctx.ok({ result })
          },
        })
        engine.emit('notify', {})
        await engine.drain()

        expect(callCount).toBe(1)
        const completed = engine.getCompleted()
        expect(completed[0].result!.payload).toEqual({ result: 'sent' })
      })

      it('effect with array key uses canonical encoding', async () => {
        engine = createEngine(opts)
        // Call two effects with array keys that would collide without encoding
        engine.process({
          name: 'multi-key',
          on: 'test',
          run: async (ctx) => {
            await ctx.effect({
              key: ['a:b', 'c'],
              run: () => 'first',
            })
            await ctx.effect({
              key: ['a', 'b:c'],
              run: () => 'second',
            })
            return ctx.ok()
          },
        })
        engine.emit('test', {})
        await engine.drain()

        const completed = engine.getCompleted()
        expect(completed).toHaveLength(1)
        expect(completed[0].result!.success).toBe(true)
      })

      it('string key does not collide with array key encoding', async () => {
        engine = createEngine(opts)
        let stringCalls = 0
        let arrayCalls = 0
        engine.process({
          name: 'collision-test',
          on: 'test',
          run: async (ctx) => {
            // A raw string that looks like an encoded array key
            const a = await ctx.effect({
              key: 'arr:v1:["x"]',
              run: () => {
                stringCalls++
                return 'from-string'
              },
            })
            // An actual array key that would encode to the same thing without prefix separation
            const b = await ctx.effect({
              key: ['x'],
              run: () => {
                arrayCalls++
                return 'from-array'
              },
            })
            return ctx.ok({ a, b })
          },
        })
        engine.emit('test', {})
        await engine.drain()

        expect(stringCalls).toBe(1)
        expect(arrayCalls).toBe(1)
        const completed = engine.getCompleted()
        expect(completed[0].result!.payload).toEqual({ a: 'from-string', b: 'from-array' })
      })

      it('schema validation with typed payload', async () => {
        engine = createEngine(opts)
        const schema = { parse: (data: unknown) => data as { count: number } }
        engine.process({
          name: 'counted',
          on: 'count.evt',
          schema,
          run: (ctx) => ctx.ok({ doubled: ctx.payload.count * 2 }),
        })
        engine.emit('count.evt', { count: 21 })
        await engine.drain()

        const completed = engine.getCompleted()
        expect(completed[0].result!.payload).toEqual({ doubled: 42 })
      })

      it('retry + effect replay through process() API', async () => {
        engine = createEngine(opts)
        let handlerCalls = 0
        let effectCalls = 0

        engine.process({
          name: 'flaky',
          on: 'retry.test',
          retry: { maxRetries: 2, delay: 0 },
          run: async (ctx) => {
            handlerCalls++
            const val = await ctx.effect({
              key: 'side-effect',
              run: () => {
                effectCalls++
                return 'done'
              },
            })
            if (handlerCalls < 2) throw new Error('transient failure')
            return ctx.ok({ val })
          },
        })

        engine.emit('retry.test', {})
        await engine.drain()

        expect(handlerCalls).toBe(2)
        expect(effectCalls).toBe(1) // effect replayed, not re-executed
        const completed = engine.getCompleted()
        expect(completed[0].result!.payload).toEqual({ val: 'done' })
      })

      it('context propagation (setContext, correlationId)', async () => {
        engine = createEngine(opts)
        engine.process({
          name: 'set-ctx',
          on: 'ctx.start',
          run: (ctx) => {
            ctx.setContext('origin', 'process-api')
            return ctx.ok(null, { emit: 'ctx.next' })
          },
        })
        engine.process({
          name: 'read-ctx',
          on: 'ctx.next',
          run: (ctx) => {
            return ctx.ok({ origin: ctx.context.origin, corr: ctx.correlationId })
          },
        })

        const [root] = engine.emit('ctx.start', {})
        await engine.drain()

        const chain = engine.getChain(root.id)
        expect(chain).toHaveLength(2)
        expect(chain[1].result!.payload).toEqual({
          origin: 'process-api',
          corr: root.correlationId,
        })
        // All runs share the same correlationId
        expect(chain.every((r) => r.correlationId === root.correlationId)).toBe(true)
      })
    })

    describe('deferred + resume', () => {
      it('deferred triggerEvent does not emit immediately', async () => {
        engine = createEngine(opts)
        let continuationFired = false
        engine.register('step1', 'start', async () => ({
          success: true,
          triggerEvent: 'continue',
          deferred: true,
          payload: { step: 1 },
        }))
        engine.register('step2', 'continue', async () => {
          continuationFired = true
          return { success: true }
        })

        await engine.emitAndWait('start', {})

        expect(continuationFired).toBe(false)
        const completed = engine.getCompleted()
        expect(completed).toHaveLength(1)
        expect(completed[0].result!.triggerEvent).toBe('continue')
        expect(completed[0].result!.deferred).toBe(true)
      })

      it('resume emits the deferred triggerEvent and continues the chain', async () => {
        engine = createEngine(opts)
        let continuationPayload: unknown = null
        engine.register('step1', 'start', async () => ({
          success: true,
          triggerEvent: 'continue',
          deferred: true,
          payload: { orderId: 'abc' },
        }))
        engine.register('step2', 'continue', async (ctx) => {
          continuationPayload = ctx.payload
          return { success: true }
        })

        await engine.emitAndWait('start', {})
        const deferred = engine.getCompleted()[0]

        const childRuns = engine.resume(deferred.id, { approved: true })
        expect(childRuns).toHaveLength(1)
        await engine.drain()

        expect(continuationPayload).toBeDefined()
        const chain = engine.getChain(deferred.id)
        expect(chain).toHaveLength(2)
        expect(chain.every((r) => r.correlationId === deferred.correlationId)).toBe(true)
      })

      it('resume merges additional payload', async () => {
        engine = createEngine(opts)
        let received: unknown = null
        engine.register('step1', 'start', async () => ({
          success: true,
          triggerEvent: 'continue',
          deferred: true,
          payload: { orderId: 'xyz' },
        }))
        engine.register('step2', 'continue', async (ctx) => {
          received = ctx.payload
          return { success: true }
        })

        await engine.emitAndWait('start', {})
        const deferred = engine.getCompleted()[0]

        engine.resume(deferred.id, { approved: true })
        await engine.drain()

        expect(received).toMatchObject({ orderId: 'xyz', approved: true })
      })

      it('resume clears deferred flag so run is no longer deferred', async () => {
        engine = createEngine(opts)
        engine.register('step1', 'start', async () => ({
          success: true,
          triggerEvent: 'continue',
          deferred: true,
          payload: { orderId: 'xyz' },
        }))
        engine.register('step2', 'continue', async () => ({ success: true }))

        await engine.emitAndWait('start', {})
        const deferred = engine.getCompleted()[0]
        expect(deferred.result?.deferred).toBe(true)

        engine.resume(deferred.id, { approved: true })
        await engine.drain()

        const after = engine.getRun(deferred.id)!
        expect(after.result?.deferred).toBe(false)
        // Cannot resume again
        expect(() => engine.resume(deferred.id)).toThrow(/not deferred/)
      })

      it('resume throws on non-completed run', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'start', async () => {
          await new Promise((r) => setTimeout(r, 100))
          return { success: true }
        })

        const [run] = engine.emit('start', {})
        expect(() => engine.resume(run.id)).toThrow(/Cannot resume/)
      })

      it('resume throws on non-deferred run', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'start', async () => ({
          success: true,
          triggerEvent: 'next',
        }))
        engine.register('noop', 'next', async () => ({ success: true }))

        await engine.emitAndWait('start', {})
        // The first run completed and already fired triggerEvent synchronously
        // Find the parent run (depth 0)
        const parent = engine.getCompleted().find((r) => r.depth === 0)!
        expect(() => engine.resume(parent.id)).toThrow(/not deferred/)
      })

      it('resume throws on run without triggerEvent', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'start', async () => ({
          success: true,
          deferred: true,
        }))

        await engine.emitAndWait('start', {})
        const run = engine.getCompleted()[0]
        expect(() => engine.resume(run.id)).toThrow(/no triggerEvent/)
      })

      it('resume leaves the run deferred when no child runs are created', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'start', async () => ({
          success: true,
          triggerEvent: 'missing',
          deferred: true,
        }))

        await engine.emitAndWait('start', {})
        const deferred = engine.getCompleted()[0]

        expect(() => engine.resume(deferred.id)).toThrow(/did not create any child runs/)
        const after = engine.getRun(deferred.id)!
        expect(after.result?.deferred).toBe(true)
      })

      it('resume throws on unknown runId', () => {
        engine = createEngine(opts)
        expect(() => engine.resume('nonexistent')).toThrow(/not found/)
      })

      it('resume with non-object payloads does not corrupt data', async () => {
        engine = createEngine(opts)
        let childPayload: unknown = null
        engine.register('step1', 'start', async () => ({
          success: true,
          triggerEvent: 'next',
          deferred: true,
          payload: 'stored-string',
        }))
        engine.register('step2', 'next', async ({ payload }) => {
          childPayload = payload
          return { success: true }
        })

        engine.emit('start', {})
        await engine.drain()

        const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
        engine.resume(deferred.id, ['a', 'b'])
        await engine.drain()

        // Non-object resume payload replaces rather than merging
        expect(childPayload).toEqual(['a', 'b'])
      })
    })
  })
}

engineTests('createEngine (memory store)', {})
engineTests('createEngine (sqlite :memory: store)', { store: { type: 'sqlite', path: ':memory:' } })

// ── Multi-waiter drain ──

function multiWaiterDrainTests(label: string, opts: EngineOptions) {
  describe(`multi-waiter drain (${label})`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('two concurrent drain() calls both resolve', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 20))
        return { success: true }
      })
      engine.emit('evt', null)

      const [r1, r2] = await Promise.all([engine.drain(), engine.drain()])

      expect(r1).toBeUndefined()
      expect(r2).toBeUndefined()
      expect(engine.getCompleted()).toHaveLength(1)
    })

    it('drain() after work is already done resolves immediately', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true }))
      engine.emit('evt', null)
      await engine.drain()

      await engine.drain()
      expect(engine.getCompleted()).toHaveLength(1)
    })

    it('per-caller timeout rejection is independent', async () => {
      engine = createEngine(opts)
      engine.register('slow', 'evt', async () => {
        await new Promise((r) => setTimeout(r, 5000))
        return { success: true }
      })
      engine.emit('evt', null)

      const shortDrain = engine.drain(30)
      const longDrain = engine.drain(10_000)

      await expect(shortDrain).rejects.toThrow('drain timed out')

      engine.stop()
    })
  })
}

multiWaiterDrainTests('memory', {})
multiWaiterDrainTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

// ── Idempotency ──

function idempotencyRaceTests(label: string, opts: EngineOptions) {
  describe(`idempotency, synchronous safety, cross-process needs UNIQUE constraint (${label})`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('synchronous double-emit with same key, second returns empty', () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true }))

      const runs1 = engine.emit('evt', 'first', { idempotencyKey: 'key-1' })
      const runs2 = engine.emit('evt', 'second', { idempotencyKey: 'key-1' })

      expect(runs1).toHaveLength(1)
      expect(runs2).toHaveLength(0)
    })

    it('rapid sequential emits, only first creates a run, rest return empty', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true }))

      const results: ReturnType<typeof engine.emit>[] = []
      for (let i = 0; i < 10; i++) {
        results.push(engine.emit('evt', i, { idempotencyKey: 'dedup' }))
      }

      await engine.drain()

      expect(results[0]).toHaveLength(1)
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toHaveLength(0)
      }
      expect(engine.getCompleted()).toHaveLength(1)
    })

    it('different idempotency keys create separate runs', async () => {
      engine = createEngine(opts)
      engine.register('proc-a', 'evt-a', async () => ({ success: true }))
      engine.register('proc-b', 'evt-b', async () => ({ success: true }))

      const runs1 = engine.emit('evt-a', 'a', { idempotencyKey: 'key-a' })
      const runs2 = engine.emit('evt-b', 'b', { idempotencyKey: 'key-b' })

      expect(runs1).toHaveLength(1)
      expect(runs2).toHaveLength(1)
    })

    it('same idempotency key can be reused for a different event', async () => {
      engine = createEngine(opts)
      engine.register('proc-a', 'evt-a', async () => ({ success: true }))
      engine.register('proc-b', 'evt-b', async () => ({ success: true }))

      const runs1 = engine.emit('evt-a', 'a', { idempotencyKey: 'shared-key' })
      const runs2 = engine.emit('evt-b', 'b', { idempotencyKey: 'shared-key' })

      expect(runs1).toHaveLength(1)
      expect(runs2).toHaveLength(1)
      await engine.drain()
      expect(engine.getCompleted()).toHaveLength(2)
    })
  })
}

idempotencyRaceTests('memory', {})
idempotencyRaceTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

// ── Convenience APIs ──

function convenienceTests(label: string, opts: EngineOptions) {
  describe(`convenience APIs (${label})`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(() => {
      engine?.stop()
    })

    it('on() registers and processes events, returns name for unregister', async () => {
      engine = createEngine(opts)
      const name = engine.on('evt', async () => ({ success: true, payload: 'auto' }))

      expect(typeof name).toBe('string')
      expect(name).toMatch(/^_auto_/)

      engine.emit('evt', null)
      await engine.drain()

      expect(engine.getCompleted()).toHaveLength(1)
      expect(engine.getCompleted()[0].result!.payload).toBe('auto')

      // Unregister using the returned name
      engine.unregister(name)
      const runs = engine.emit('evt', null)
      expect(runs).toHaveLength(0)
    })

    it('registerMany() batch registers, all handlers fire', async () => {
      engine = createEngine(opts)
      engine.registerMany([
        { name: 'a', event: 'evt', handler: async () => ({ success: true, payload: 'a' }) },
        { name: 'b', event: 'evt', handler: async () => ({ success: true, payload: 'b' }) },
        { name: 'c', event: 'other', handler: async () => ({ success: true, payload: 'c' }) },
      ])

      engine.emit('evt', null)
      engine.emit('other', null)
      await engine.drain()

      expect(engine.getCompleted()).toHaveLength(3)
    })

    it('emitAndWait() returns completed runs', async () => {
      engine = createEngine(opts)
      engine.register('proc', 'evt', async () => ({ success: true, payload: 'done' }))

      const runs = await engine.emitAndWait('evt', 'data')

      expect(runs).toHaveLength(1)
      expect(runs[0].state).toBe('completed')
      expect(runs[0].result!.payload).toBe('done')
    })

    it('emitAndWait() with no matching handlers returns empty', async () => {
      engine = createEngine(opts)

      const runs = await engine.emitAndWait('no-handler', null)
      expect(runs).toHaveLength(0)
    })

    it('emitAndWait() only waits for the emitted chain, not unrelated work', async () => {
      engine = createEngine(opts)
      engine.register('slow', 'slow', async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { success: true }
      })
      engine.register('fast', 'fast', async () => ({ success: true, payload: 'fast-done' }))

      engine.emit('slow', null)
      await new Promise((r) => setTimeout(r, 10))

      const runs = await engine.emitAndWait('fast', null, { timeoutMs: 50 })
      expect(runs).toHaveLength(1)
      expect(runs[0].result!.payload).toBe('fast-done')
    })

    it('emitAndWait() does not time out when retention runs before descendants finish', async () => {
      engine = createEngine({ ...opts, retention: 1 })
      engine.register('root', 'start', async () => ({ success: true, triggerEvent: 'next' }))
      engine.register('child', 'next', async () => {
        await new Promise((r) => setTimeout(r, 40))
        return { success: true, payload: 'done' }
      })

      const runs = await engine.emitAndWait('start', {}, { timeoutMs: 200 })
      expect(runs).toHaveLength(1)
      expect(runs[0].state).toBe('completed')
    })
  })
}

convenienceTests('memory', {})
convenienceTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

describe('getGraph', () => {
  it('builds graph from process registrations with explicit emits', async () => {
    const engine = createEngine()

    engine.register(
      'validate',
      'order:new',
      async () => ({
        success: true,
        triggerEvent: 'order:validated',
      }),
      { emits: ['order:validated'] },
    )
    engine.register(
      'charge',
      'order:validated',
      async () => ({
        success: true,
        triggerEvent: 'order:charged',
      }),
      { emits: ['order:charged'] },
    )
    engine.register('fulfill', 'order:charged', async () => ({
      success: true,
    }))

    const graph = engine.getGraph()

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.find((n) => n.name === 'validate')?.emits).toEqual(['order:validated'])
    expect(graph.nodes.find((n) => n.name === 'charge')?.emits).toEqual(['order:charged'])
    expect(graph.nodes.find((n) => n.name === 'fulfill')?.emits).toEqual([])

    expect(graph.edges).toHaveLength(2)
    expect(graph.edges).toContainEqual({ from: 'validate', event: 'order:validated', to: 'charge' })
    expect(graph.edges).toContainEqual({ from: 'charge', event: 'order:charged', to: 'fulfill' })

    await engine.stop()
  })

  it('builds graph from process() API with explicit emits', async () => {
    const engine = createEngine()

    engine.process({
      name: 'research',
      on: 'topic:assigned',
      emits: ['topic:analyzed'],
      run: async (ctx) => ctx.ok({ done: true }, { emit: 'topic:analyzed' }),
    })
    engine.process({
      name: 'summarize',
      on: 'topic:analyzed',
      run: async (ctx) => ctx.ok(),
    })

    const graph = engine.getGraph()

    expect(graph.nodes.find((n) => n.name === 'research')?.emits).toEqual(['topic:analyzed'])
    expect(graph.edges).toContainEqual({ from: 'research', event: 'topic:analyzed', to: 'summarize' })

    await engine.stop()
  })

  it('supports explicit emits declaration', async () => {
    const engine = createEngine()

    engine.process({
      name: 'router',
      on: 'request',
      emits: ['route:a', 'route:b'],
      run: async (ctx) => {
        const target = (ctx.payload as any).target
        return ctx.ok({}, { emit: target })
      },
    })
    engine.process({ name: 'handle-a', on: 'route:a', run: async (ctx) => ctx.ok() })
    engine.process({ name: 'handle-b', on: 'route:b', run: async (ctx) => ctx.ok() })

    const graph = engine.getGraph()

    expect(graph.nodes.find((n) => n.name === 'router')?.emits).toEqual(['route:a', 'route:b'])
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges).toContainEqual({ from: 'router', event: 'route:a', to: 'handle-a' })
    expect(graph.edges).toContainEqual({ from: 'router', event: 'route:b', to: 'handle-b' })

    await engine.stop()
  })

  it('handles fan-out (one event, multiple listeners)', async () => {
    const engine = createEngine()

    engine.register('emitter', 'start', async () => ({ success: true, triggerEvent: 'next' }), { emits: ['next'] })
    engine.register('listener-a', 'next', async () => ({ success: true }))
    engine.register('listener-b', 'next', async () => ({ success: true }))

    const graph = engine.getGraph()

    expect(graph.edges).toContainEqual({ from: 'emitter', event: 'next', to: 'listener-a' })
    expect(graph.edges).toContainEqual({ from: 'emitter', event: 'next', to: 'listener-b' })

    await engine.stop()
  })

  it('returns empty graph when no processes registered', async () => {
    const engine = createEngine()
    const graph = engine.getGraph()
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    await engine.stop()
  })
})
