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

    it('singleton process: skips events while first is active', async () => {
      engine = createEngine(opts)
      engine.register(
        'proc',
        'evt',
        async () => {
          await new Promise((r) => setTimeout(r, 50))
          return { success: true }
        },
        { singleton: true },
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
  })
}

convenienceTests('memory', {})
convenienceTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
