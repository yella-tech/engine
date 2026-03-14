import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createBus } from './bus.js'
import { createDispatcher } from './dispatcher.js'
import { createRegistry } from './registry.js'
import { createRunStore } from './run.js'
import type { HandlerResult, Run, RunStore } from './types.js'
import type { Registry } from './registry.js'

describe('createBus', () => {
  let registry: Registry
  let store: RunStore
  let bus: ReturnType<typeof createBus>

  beforeEach(() => {
    registry = createRegistry()
    store = createRunStore()
    bus = createBus(registry, store, {
      maxChainDepth: 10,
      maxPayloadBytes: 1_048_576,
      handlerTimeoutMs: 30_000,
      emitEvent: () => {},
    })
  })

  describe('enqueue', () => {
    it('creates idle runs for each matching handler', () => {
      registry.register('proc', 'myEvent', async () => ({ success: true }))
      const runs = bus.enqueue('myEvent', { data: 1 })
      expect(runs).toHaveLength(1)
      expect(runs[0].state).toBe('idle')
      expect(runs[0].processName).toBe('proc')
      expect(runs[0].payload).toEqual({ data: 1 })
    })

    it('returns empty array when no handlers match', () => {
      const runs = bus.enqueue('unknown', null)
      expect(runs).toEqual([])
    })

    it('passes parentRunId, correlationId, context through to store', () => {
      registry.register('proc', 'evt', async () => ({ success: true }))
      const parentRun = store.create('parent', 'init', null)
      const runs = bus.enqueue('evt', null, parentRun.id, 'corr-42', { inherited: true })
      expect(runs[0].parentRunId).toBe(parentRun.id)
      expect(runs[0].correlationId).toBe('corr-42')
      expect(runs[0].context).toEqual({ inherited: true })
    })

    it('multiple handlers on same event creates multiple runs', () => {
      registry.register('a', 'evt', async () => ({ success: true }))
      registry.register('b', 'evt', async () => ({ success: true }))
      const runs = bus.enqueue('evt', null)
      expect(runs).toHaveLength(2)
      expect(runs.map((r) => r.processName).sort()).toEqual(['a', 'b'])
    })

    it('same idempotency key on different events does not collide', () => {
      registry.register('proc-a', 'evt-a', async () => ({ success: true }))
      registry.register('proc-b', 'evt-b', async () => ({ success: true }))

      const first = bus.enqueue('evt-a', 'a', null, undefined, undefined, 'shared-key')
      const second = bus.enqueue('evt-b', 'b', null, undefined, undefined, 'shared-key')

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(1)
      expect(store.getAll()).toHaveLength(2)
    })

    it('duplicate idempotent fan-out creates the batch once and the retry no-ops', () => {
      registry.register('a', 'evt', async () => ({ success: true }))
      registry.register('b', 'evt', async () => ({ success: true }))

      const first = bus.enqueue('evt', null, null, undefined, undefined, 'batch-key')
      const second = bus.enqueue('evt', null, null, undefined, undefined, 'batch-key')

      expect(first).toHaveLength(2)
      expect(second).toEqual([])
      expect(store.getAll()).toHaveLength(2)
    })

    it('does not rely on stale hasActiveRun reads for singleton admission', () => {
      const baseStore = createRunStore()
      const originalCreate = baseStore.create
      const staleStore: RunStore = {
        ...baseStore,
        hasActiveRun: () => false,
        create(...args) {
          return originalCreate(...args)
        },
      }

      const staleBus = createBus(registry, staleStore, {
        maxChainDepth: 10,
        maxPayloadBytes: 1_048_576,
        handlerTimeoutMs: 30_000,
        emitEvent: () => {},
      })

      registry.register('singleton-proc', 'evt', async () => ({ success: true }), { singleton: true })

      const first = staleBus.enqueue('evt', 'a')
      const second = staleBus.enqueue('evt', 'b')

      expect(first).toHaveLength(1)
      expect(second).toHaveLength(0)
      expect(staleStore.getAll()).toHaveLength(1)
    })
  })

  describe('executeRun', () => {
    it('executes handler, stores result, transitions to completed', async () => {
      registry.register('proc', 'evt', async () => ({ success: true, payload: 'done' }))
      const [run] = bus.enqueue('evt', 'input')
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.state).toBe('completed')
      expect(finished.result).toEqual({ success: true, payload: 'done' })
    })

    it('handler returning success:false transitions to errored', async () => {
      registry.register('proc', 'evt', async () => ({ success: false, error: 'bad' }))
      const [run] = bus.enqueue('evt', null)
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.state).toBe('errored')
      expect(finished.result!.error).toBe('bad')
    })

    it('handler throwing catches, transitions to errored, stores error', async () => {
      registry.register('proc', 'evt', async () => {
        throw new Error('kaboom')
      })
      const [run] = bus.enqueue('evt', null)
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.state).toBe('errored')
      expect(finished.result!.error).toBe('kaboom')
    })

    it('handler not found in registry transitions to errored', async () => {
      registry.register('proc', 'evt', async () => ({ success: true }))
      const [run] = bus.enqueue('evt', null)
      store.transition(run.id, 'running')
      // Remove handler after enqueue
      registry.unregister('proc')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.state).toBe('errored')
      expect(finished.result!.error).toContain('No handler found')
    })

    it('setContext in handler persists via store.updateContext', async () => {
      registry.register('proc', 'evt', async (ctx) => {
        ctx.setContext('added', 'value')
        return { success: true }
      })
      const [run] = bus.enqueue('evt', null)
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.context.added).toBe('value')
    })

    it('triggerEvent enqueues child runs with parent linkage and context', async () => {
      registry.register('parent', 'start', async (ctx) => {
        ctx.setContext('fromParent', true)
        return { success: true, triggerEvent: 'next', payload: 'child-data' }
      })
      registry.register('child', 'next', async () => ({ success: true }))

      const [run] = bus.enqueue('start', null)
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const parentRun = store.get(run.id)!
      expect(parentRun.childRunIds).toHaveLength(1)

      const childRun = store.get(parentRun.childRunIds[0])!
      expect(childRun.parentRunId).toBe(run.id)
      expect(childRun.correlationId).toBe(run.correlationId)
      expect(childRun.payload).toBe('child-data')
      expect(childRun.context.fromParent).toBe(true)
    })

    it('triggerEvent with no matching handler produces no child runs and no error', async () => {
      registry.register('proc', 'evt', async () => ({
        success: true,
        triggerEvent: 'nonexistent',
      }))
      const [run] = bus.enqueue('evt', null)
      store.transition(run.id, 'running')

      await bus.executeRun(run)

      const finished = store.get(run.id)!
      expect(finished.state).toBe('completed')
      expect(finished.childRunIds).toHaveLength(0)
    })

    it('fences context updates after lease ownership changes', async () => {
      const baseStore = createRunStore()
      let leaseLost = false
      const leasedStore: RunStore = {
        ...baseStore,
        get(runId: string) {
          const run = baseStore.get(runId)
          if (!run) return null
          if (leaseLost && run.state === 'running') {
            return { ...run, leaseOwner: 'owner-2' }
          }
          return run
        },
      }
      const leasedBus = createBus(registry, leasedStore, {
        maxChainDepth: 10,
        maxPayloadBytes: 1_048_576,
        handlerTimeoutMs: 30_000,
        leaseOwner: 'owner-1',
        emitEvent: () => {},
      })

      let releaseHandler!: () => void
      const handlerReady = new Promise<void>((resolve) => {
        releaseHandler = resolve
      })

      registry.register('proc', 'evt', async (ctx) => {
        await handlerReady
        ctx.setContext('unsafe', true)
        return { success: true }
      })

      const [run] = leasedBus.enqueue('evt', null)
      const [claimed] = leasedStore.claimIdle(1, 'owner-1', 30_000)
      const execution = leasedBus.executeRun(claimed)

      leaseLost = true
      releaseHandler()
      await execution

      const stored = baseStore.get(run.id)!
      expect(stored.context.unsafe).toBeUndefined()
      expect(stored.result).toBeNull()
      expect(stored.state).toBe('running')
    })

    it('does not finalize a handler result after lease ownership changes', async () => {
      const baseStore = createRunStore()
      let leaseLost = false
      const leasedStore: RunStore = {
        ...baseStore,
        get(runId: string) {
          const run = baseStore.get(runId)
          if (!run) return null
          if (leaseLost && run.state === 'running') {
            return { ...run, leaseOwner: 'owner-2' }
          }
          return run
        },
      }
      const leasedBus = createBus(registry, leasedStore, {
        maxChainDepth: 10,
        maxPayloadBytes: 1_048_576,
        handlerTimeoutMs: 30_000,
        leaseOwner: 'owner-1',
        emitEvent: () => {},
      })

      registry.register('proc', 'evt', async () => {
        leaseLost = true
        return { success: true, payload: 'done' }
      })

      const [run] = leasedBus.enqueue('evt', null)
      const [claimed] = leasedStore.claimIdle(1, 'owner-1', 30_000)
      await leasedBus.executeRun(claimed)

      const stored = baseStore.get(run.id)!
      expect(stored.result).toBeNull()
      expect(stored.state).toBe('running')
    })
  })
})

describe('createDispatcher', () => {
  let store: RunStore

  beforeEach(() => {
    store = createRunStore()
  })

  it('kick fills slots up to concurrency limit', async () => {
    for (let i = 0; i < 5; i++) store.create('p', 'e', null)

    let executing = 0
    let maxConcurrent = 0
    const allDone = new Promise<void>((resolve) => {
      const executeRun = async (run: Run) => {
        executing++
        maxConcurrent = Math.max(maxConcurrent, executing)
        await new Promise((r) => setTimeout(r, 10))
        store.transition(run.id, 'completed')
        executing--
      }

      const dispatcher = createDispatcher(store, executeRun, 2)
      dispatcher.onDrain(() => resolve())
      dispatcher.kick()
    })

    await allDone
    expect(maxConcurrent).toBe(2)
  })

  it('kick is a no-op when queue is empty', () => {
    const executeRun = vi.fn(async () => {})
    const dispatcher = createDispatcher(store, executeRun, 5)
    dispatcher.kick()
    expect(executeRun).not.toHaveBeenCalled()
  })

  it('never exceeds concurrency limit', async () => {
    for (let i = 0; i < 20; i++) store.create('p', 'e', null)

    let executing = 0
    let maxConcurrent = 0
    const allDone = new Promise<void>((resolve) => {
      const executeRun = async (run: Run) => {
        executing++
        maxConcurrent = Math.max(maxConcurrent, executing)
        await new Promise((r) => setTimeout(r, 5))
        store.transition(run.id, 'completed')
        executing--
      }

      const dispatcher = createDispatcher(store, executeRun, 3)
      dispatcher.onDrain(() => resolve())
      dispatcher.kick()
    })

    await allDone
    expect(maxConcurrent).toBe(3)
    expect(store.getByState('completed')).toHaveLength(20)
  })

  it('completion triggers next: when run finishes, next idle is picked up', async () => {
    store.create('p', 'e', null)
    store.create('p', 'e', null)

    const order: string[] = []
    const allDone = new Promise<void>((resolve) => {
      const executeRun = async (run: Run) => {
        order.push(run.id)
        await new Promise((r) => setTimeout(r, 5))
        store.transition(run.id, 'completed')
      }

      const dispatcher = createDispatcher(store, executeRun, 1)
      dispatcher.onDrain(() => resolve())
      dispatcher.kick()
    })

    await allDone
    expect(order).toHaveLength(2)
  })

  it('stop prevents new claims after stop', async () => {
    store.create('p', 'e', null)
    store.create('p', 'e', null)
    store.create('p', 'e', null)

    let ran = 0
    const executeRun = async (run: Run) => {
      ran++
      await new Promise((r) => setTimeout(r, 10))
      store.transition(run.id, 'completed')
    }

    const dispatcher = createDispatcher(store, executeRun, 1)
    dispatcher.kick()
    // Stop immediately, only the first should be in-flight
    dispatcher.stop()

    await new Promise((r) => setTimeout(r, 50))
    // At most 1 should have run (the one claimed before stop)
    expect(ran).toBe(1)
  })

  it('onDrain fires when active=0 and idle=0', async () => {
    store.create('p', 'e', null)

    const drained = new Promise<void>((resolve) => {
      const executeRun = async (run: Run) => {
        store.transition(run.id, 'completed')
      }

      const dispatcher = createDispatcher(store, executeRun, 5)
      dispatcher.onDrain(() => resolve())
      dispatcher.kick()
    })

    await drained
    // If we get here, drain fired
    expect(store.getByState('completed')).toHaveLength(1)
  })

  it('aborts an in-flight run when heartbeat loses the lease', async () => {
    store.create('p', 'e', null)

    let resolveRun!: () => void
    const executeRun = vi.fn(
      (run: Run) =>
        new Promise<void>((resolve) => {
          resolveRun = () => {
            store.transition(run.id, 'completed')
            resolve()
          }
        }),
    )
    const heartbeat = vi.fn(() => false)
    const abortRun = vi.fn()
    const leasedStore: RunStore = {
      ...store,
      heartbeat,
    }

    const dispatcher = createDispatcher(leasedStore, executeRun, 1, { leaseOwner: 'owner-1', leaseTimeoutMs: 30_000, heartbeatIntervalMs: 5 }, undefined, abortRun)
    dispatcher.kick()

    await new Promise((r) => setTimeout(r, 20))
    expect(abortRun).toHaveBeenCalledTimes(1)
    expect(abortRun).toHaveBeenCalledWith(expect.any(String), 'run lease lost')

    resolveRun()
    await dispatcher.waitForActive()
  })
})
