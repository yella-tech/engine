import { describe, it, expect, afterEach } from 'vitest'
import { createEngine, VALID_TRANSITIONS } from './index.js'
import type { EngineOptions, ProcessState } from './types.js'
import { createRunStore } from './run.js'
import { createSqliteRunStore } from './run-sqlite.js'
import type { RunStore } from './types.js'

// ── State Transition Validation ──

describe('state transition validation', () => {
  function storeTests(label: string, makeStore: () => RunStore) {
    describe(label, () => {
      let store: RunStore

      afterEach(() => store.close?.())

      it('allows idle → running', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        expect(() => store.transition(run.id, 'running')).not.toThrow()
      })

      it('allows running → completed', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        expect(() => store.transition(run.id, 'completed')).not.toThrow()
      })

      it('allows running → errored', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        expect(() => store.transition(run.id, 'errored', { error: 'fail' })).not.toThrow()
      })

      it('rejects idle → completed', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        expect(() => store.transition(run.id, 'completed')).toThrow('Invalid transition')
      })

      it('allows idle → errored', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        expect(() => store.transition(run.id, 'errored')).not.toThrow()
      })

      it('rejects completed → running', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        store.transition(run.id, 'completed')
        expect(() => store.transition(run.id, 'running')).toThrow('Invalid transition')
      })

      it('rejects completed → errored', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        store.transition(run.id, 'completed')
        expect(() => store.transition(run.id, 'errored')).toThrow('Invalid transition')
      })

      it('rejects errored → running', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        store.transition(run.id, 'errored', { error: 'fail' })
        expect(() => store.transition(run.id, 'running')).toThrow('Invalid transition')
      })

      it('rejects errored → completed', () => {
        store = makeStore()
        const run = store.create('p', 'e', null)
        store.transition(run.id, 'running')
        store.transition(run.id, 'errored', { error: 'fail' })
        expect(() => store.transition(run.id, 'completed')).toThrow('Invalid transition')
      })
    })
  }

  storeTests('memory store', () => createRunStore())
  storeTests('sqlite store', () => createSqliteRunStore(':memory:'))
})

// ── VALID_TRANSITIONS export ──

describe('VALID_TRANSITIONS', () => {
  it('is exported and has correct shape', () => {
    expect(VALID_TRANSITIONS.idle).toEqual(['running', 'errored'])
    expect(VALID_TRANSITIONS.running).toEqual(['completed', 'errored', 'idle'])
    expect(VALID_TRANSITIONS.completed).toEqual([])
    expect(VALID_TRANSITIONS.errored).toEqual(['idle'])
  })
})

// ── Chain Depth Limit ──

describe('chain depth limit', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('allows chains within depth limit', async () => {
        engine = createEngine({ ...opts, maxChainDepth: 3 })
        engine.register('step0', 'e0', async () => ({ success: true, triggerEvent: 'e1' }))
        engine.register('step1', 'e1', async () => ({ success: true, triggerEvent: 'e2' }))
        engine.register('step2', 'e2', async () => ({ success: true }))

        engine.emit('e0', null)
        await engine.drain()

        expect(engine.getCompleted()).toHaveLength(3)
        expect(engine.getErrored()).toHaveLength(0)
      })

      it('rejects child beyond max depth, child is never created', async () => {
        engine = createEngine({ ...opts, maxChainDepth: 1 })
        engine.register('step0', 'e0', async () => ({ success: true, triggerEvent: 'e1' }))
        engine.register('step1', 'e1', async () => ({ success: true, triggerEvent: 'e2' }))
        engine.register('step2', 'e2', async () => ({ success: true }))

        const [root] = engine.emit('e0', null)
        await engine.drain()

        // step0 completes (depth 0), step1 runs at depth 1 (== maxChainDepth)
        // step1 triggers e2, but child depth would be 2 > maxChainDepth=1
        // step1 already completed before enqueue, so it stays completed
        // step2 is never created
        const completed = engine.getCompleted()
        expect(completed).toHaveLength(2) // step0 and step1
        expect(completed.map((r) => r.processName).sort()).toEqual(['step0', 'step1'])

        // step2 was never created
        const chain = engine.getChain(root.id)
        expect(chain).toHaveLength(2)
      })

      it('depth is tracked on runs', async () => {
        engine = createEngine({ ...opts, maxChainDepth: 10 })
        engine.register('root', 'start', async () => ({ success: true, triggerEvent: 'next' }))
        engine.register('child', 'next', async () => ({ success: true }))

        const [root] = engine.emit('start', null)
        await engine.drain()

        const rootRun = engine.getRun(root.id)!
        expect(rootRun.depth).toBe(0)

        const chain = engine.getChain(root.id)
        const childRun = chain.find((r) => r.processName === 'child')!
        expect(childRun.depth).toBe(1)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Active-Process Dedup ──

describe('singleton process', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('skips second emit while first is active', async () => {
        engine = createEngine(opts)
        engine.register(
          'slow',
          'evt',
          async () => {
            await new Promise((r) => setTimeout(r, 50))
            return { success: true }
          },
          { singleton: true },
        )

        const first = engine.emit('evt', 'a')
        const second = engine.emit('evt', 'b')

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(0)

        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(1)
      })

      it('allows re-emit after first completes', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }), { singleton: true })

        engine.emit('evt', 'a')
        await engine.drain()

        const second = engine.emit('evt', 'b')
        expect(second).toHaveLength(1)
        await engine.drain()

        expect(engine.getCompleted()).toHaveLength(2)
      })

      it('only the singleton process is skipped, non-singleton on same event still fires', async () => {
        engine = createEngine(opts)
        engine.register(
          'procA',
          'evt',
          async () => {
            await new Promise((r) => setTimeout(r, 100))
            return { success: true }
          },
          { singleton: true },
        )
        engine.register('procB', 'evt', async () => ({ success: true }))

        const first = engine.emit('evt', 'x')
        expect(first).toHaveLength(2) // both created

        // Wait for procB to complete but procA is still running
        await new Promise((r) => setTimeout(r, 30))

        const second = engine.emit('evt', 'y')
        // procA is skipped (singleton, still active), procB fires normally
        expect(second).toHaveLength(1)
        expect(second[0].processName).toBe('procB')

        await engine.drain()
      })

      it('non-singleton processes allow concurrent runs by default', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => {
          await new Promise((r) => setTimeout(r, 50))
          return { success: true }
        })

        const first = engine.emit('evt', 'a')
        const second = engine.emit('evt', 'b')

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)

        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(2)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Idempotency Key ──

describe('idempotency key', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('duplicate idempotency key returns empty array', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        const first = engine.emit('evt', 'a', { idempotencyKey: 'key-1' })
        expect(first).toHaveLength(1)

        const second = engine.emit('evt', 'b', { idempotencyKey: 'key-1' })
        expect(second).toHaveLength(0)

        await engine.drain()
      })

      it('accepts different idempotency key', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        engine.emit('evt', 'a', { idempotencyKey: 'key-1' })
        await engine.drain()

        const second = engine.emit('evt', 'b', { idempotencyKey: 'key-2' })
        expect(second).toHaveLength(1)

        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(2)
      })

      it('idempotencyKey is stored on run', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        const [run] = engine.emit('evt', null, { idempotencyKey: 'my-key' })
        expect(run.idempotencyKey).toBe('my-key')

        await engine.drain()
      })

      it('emit without idempotencyKey has null key', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        const [run] = engine.emit('evt', null)
        expect(run.idempotencyKey).toBeNull()

        await engine.drain()
      })

      it('multi-handler emission with idempotency key creates all runs', async () => {
        engine = createEngine(opts)
        engine.register('handlerA', 'evt', async () => ({ success: true }))
        engine.register('handlerB', 'evt', async () => ({ success: true }))

        const runs = engine.emit('evt', null, { idempotencyKey: 'multi-key' })
        expect(runs).toHaveLength(2)
        expect(runs[0].idempotencyKey).toBe('multi-key')
        expect(runs[1].idempotencyKey).toBe('multi-key')

        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(2)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Payload Size Limits ──

describe('payload size limits', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('rejects oversized input payload', () => {
        engine = createEngine({ ...opts, maxPayloadBytes: 100 })
        engine.register('proc', 'evt', async () => ({ success: true }))

        const bigPayload = 'x'.repeat(200)
        expect(() => engine.emit('evt', bigPayload)).toThrow('payload exceeds max size')
      })

      it('allows at-limit payload', async () => {
        engine = createEngine({ ...opts, maxPayloadBytes: 100 })
        engine.register('proc', 'evt', async () => ({ success: true }))

        // JSON.stringify of a 98-char string is 100 bytes (2 quotes)
        const payload = 'x'.repeat(98)
        expect(() => engine.emit('evt', payload)).not.toThrow()

        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(1)
      })

      it('rejects oversized result payload', async () => {
        engine = createEngine({ ...opts, maxPayloadBytes: 100 })
        engine.register('proc', 'evt', async () => ({
          success: true,
          payload: 'y'.repeat(200),
        }))

        engine.emit('evt', 'small')
        await engine.drain()

        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result!.error).toBe('payload exceeds max size')
      })

      it('emoji payload exceeding byte limit is rejected despite fitting code-unit count', () => {
        engine = createEngine({ ...opts, maxPayloadBytes: 100 })
        engine.register('proc', 'evt', async () => ({ success: true }))

        const emojis = '😀'.repeat(25) // 25 emojis = 50 code units, 100 bytes content + 2 quote bytes = 102
        expect(() => engine.emit('evt', emojis)).toThrow('payload exceeds max size')
      })

      it('ASCII string at exact byte limit is accepted', () => {
        const limit = 200
        engine = createEngine({ ...opts, maxPayloadBytes: limit })
        engine.register('proc', 'evt', async () => ({ success: true }))

        const exactFit = 'x'.repeat(limit - 2) // + 2 quotes = exactly limit bytes
        const runs = engine.emit('evt', exactFit)
        expect(runs).toHaveLength(1)
      })

      it('result payload with emoji exceeding byte limit transitions to errored', async () => {
        const emojis = '😀'.repeat(25)
        engine = createEngine({ ...opts, maxPayloadBytes: 100 })
        engine.register('proc', 'evt', async () => ({
          success: true,
          payload: emojis,
        }))

        engine.emit('evt', null)
        await engine.drain()

        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result!.error).toBe('payload exceeds max size')
      })

      it('allows undefined payload', async () => {
        engine = createEngine({ ...opts, maxPayloadBytes: 10 })
        engine.register('proc', 'evt', async () => ({ success: true }))

        expect(() => engine.emit('evt', undefined)).not.toThrow()
        await engine.drain()
        expect(engine.getCompleted()).toHaveLength(1)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Handler Timeouts ──

describe('handler timeout', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('errors run when handler exceeds timeout', async () => {
        engine = createEngine({ ...opts, handlerTimeoutMs: 50 })
        engine.register('slow', 'evt', async () => {
          await new Promise((r) => setTimeout(r, 500))
          return { success: true }
        })

        engine.emit('evt', null)
        await engine.drain(5000)

        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result!.error).toBe('handler timed out')
      })

      it('succeeds when handler completes within timeout', async () => {
        engine = createEngine({ ...opts, handlerTimeoutMs: 1000 })
        engine.register('fast', 'evt', async () => {
          await new Promise((r) => setTimeout(r, 5))
          return { success: true }
        })

        engine.emit('evt', null)
        await engine.drain()

        expect(engine.getCompleted()).toHaveLength(1)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Schema Validation ──

describe('schema validation', () => {
  // Simple Schema<T> implementation for testing (no zod needed)
  function createSchema<T>(validate: (data: unknown) => T) {
    return {
      parse(data: unknown): T {
        return validate(data)
      },
    }
  }

  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('valid payload passes schema and handler runs', async () => {
        engine = createEngine(opts)
        const schema = createSchema((data) => {
          if (typeof data !== 'object' || data === null || !('name' in data)) {
            throw new Error('Expected object with name')
          }
          return data as { name: string }
        })

        engine.register('proc', 'evt', schema, async (ctx) => {
          return { success: true, payload: ctx.payload }
        })

        engine.emit('evt', { name: 'hello' })
        await engine.drain()

        const completed = engine.getCompleted()
        expect(completed).toHaveLength(1)
        expect(completed[0].result!.payload).toEqual({ name: 'hello' })
      })

      it('invalid payload errors before handler runs', async () => {
        engine = createEngine(opts)
        let handlerCalled = false
        const schema = createSchema((data) => {
          if (typeof data !== 'number') throw new Error('Expected number')
          return data
        })

        engine.register('proc', 'evt', schema, async () => {
          handlerCalled = true
          return { success: true }
        })

        engine.emit('evt', 'not-a-number')
        await engine.drain()

        expect(handlerCalled).toBe(false)
        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result!.error).toBe('Expected number')
      })

      it('register without schema works as before', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        engine.emit('evt', 'anything')
        await engine.drain()

        expect(engine.getCompleted()).toHaveLength(1)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})

// ── Store: hasActiveRun / hasIdempotencyKey ──

describe('RunStore guard methods', () => {
  function storeTests(label: string, makeStore: () => RunStore) {
    describe(label, () => {
      let store: RunStore
      afterEach(() => store.close?.())

      it('hasActiveRun returns true for idle run', () => {
        store = makeStore()
        store.create('proc', 'evt', null)
        expect(store.hasActiveRun('proc')).toBe(true)
      })

      it('hasActiveRun returns true for running run', () => {
        store = makeStore()
        const run = store.create('proc', 'evt', null)
        store.transition(run.id, 'running')
        expect(store.hasActiveRun('proc')).toBe(true)
      })

      it('hasActiveRun returns false for completed run', () => {
        store = makeStore()
        const run = store.create('proc', 'evt', null)
        store.transition(run.id, 'running')
        store.transition(run.id, 'completed')
        expect(store.hasActiveRun('proc')).toBe(false)
      })

      it('hasActiveRun returns false for unknown process', () => {
        store = makeStore()
        expect(store.hasActiveRun('unknown')).toBe(false)
      })

      it('hasIdempotencyKey returns true for existing key', () => {
        store = makeStore()
        store.create('proc', 'evt', null, null, undefined, undefined, 0, 'my-key')
        expect(store.hasIdempotencyKey('my-key')).toBe(true)
      })

      it('hasIdempotencyKey returns false for unknown key', () => {
        store = makeStore()
        expect(store.hasIdempotencyKey('nope')).toBe(false)
      })

      it('hasIdempotencyKey ignores null keys', () => {
        store = makeStore()
        store.create('proc', 'evt', null)
        expect(store.hasIdempotencyKey('null')).toBe(false)
      })
    })
  }

  storeTests('memory store', () => createRunStore())
  storeTests('sqlite store', () => createSqliteRunStore(':memory:'))
})

// ── Run: depth field ──

describe('Run depth field', () => {
  function storeTests(label: string, makeStore: () => RunStore) {
    describe(label, () => {
      let store: RunStore
      afterEach(() => store.close?.())

      it('defaults depth to 0', () => {
        store = makeStore()
        const run = store.create('proc', 'evt', null)
        expect(run.depth).toBe(0)
      })

      it('accepts explicit depth', () => {
        store = makeStore()
        const run = store.create('proc', 'evt', null, null, undefined, undefined, 5)
        expect(run.depth).toBe(5)
      })

      it('depth persists on get()', () => {
        store = makeStore()
        const run = store.create('proc', 'evt', null, null, undefined, undefined, 3)
        const fetched = store.get(run.id)!
        expect(fetched.depth).toBe(3)
      })
    })
  }

  storeTests('memory store', () => createRunStore())
  storeTests('sqlite store', () => createSqliteRunStore(':memory:'))
})

// ── Circular Payload ──

describe('circular payload', () => {
  function engineTests(label: string, opts: EngineOptions) {
    describe(label, () => {
      let engine: ReturnType<typeof createEngine>
      afterEach(() => engine?.stop())

      it('emit() with circular input payload throws before any run is created', () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => ({ success: true }))

        const circular: Record<string, unknown> = { a: 1 }
        circular.self = circular

        expect(() => engine.emit('evt', circular)).toThrow()
        expect(engine.getIdle()).toHaveLength(0)
        expect(engine.getRunning()).toHaveLength(0)
      })

      it('handler returning circular result payload transitions run to errored', async () => {
        engine = createEngine(opts)
        engine.register('proc', 'evt', async () => {
          const circular: Record<string, unknown> = { b: 2 }
          circular.self = circular
          return { success: true, payload: circular }
        })

        engine.emit('evt', null)
        await engine.drain()

        const errored = engine.getErrored()
        expect(errored).toHaveLength(1)
        expect(errored[0].result!.error).toMatch(/circular/i)
      })
    })
  }

  engineTests('memory', {})
  engineTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
})
