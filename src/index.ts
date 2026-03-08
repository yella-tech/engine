import crypto from 'node:crypto'
import { createBus } from './bus.js'
import { createDispatcher } from './dispatcher.js'
import { createEffectStore } from './effect.js'
import { createRegistry } from './registry.js'
import { createRunStore } from './run.js'
import { createSqliteStores } from './run-sqlite.js'
import { EngineError, ErrorCode } from './types.js'
import { safeCallHook } from './util.js'
import type {
  DevServer,
  EffectRecord,
  EffectStore,
  Engine,
  EngineOptions,
  Handler,
  HandlerContext,
  HandlerResult,
  ProcessContext,
  ProcessDefinition,
  ProcessDefinitionConfig,
  RetryPolicy,
  Run,
  RunStore,
  Schema,
  EventGraph,
  EventGraphNode,
  EventGraphEdge,
} from './types.js'

export type {
  DevServer,
  DevServerOptions,
  EffectFn,
  EffectRecord,
  EffectState,
  EffectStore,
  Engine,
  EngineOptions,
  Handler,
  HandlerContext,
  HandlerResult,
  ProcessContext,
  ProcessDefinition,
  ProcessDefinitionConfig,
  ProcessState,
  RetryPolicy,
  Run,
  RunStore,
  Schema,
  TimelineEntry,
  EventGraph,
  EventGraphNode,
  EventGraphEdge,
} from './types.js'
export { EngineError, ErrorCode, VALID_TRANSITIONS } from './types.js'
export { createEffectStore } from './effect.js'
export { createSqliteStores } from './run-sqlite.js'

function buildStores(opts: EngineOptions): { runStore: RunStore; effectStore: EffectStore; close?: () => void } {
  if (opts.store === 'memory') {
    return { runStore: createRunStore(), effectStore: createEffectStore() }
  }
  if (opts.store) {
    const stores = createSqliteStores(opts.store.path)
    return { runStore: stores.runStore, effectStore: stores.effectStore, close: stores.close }
  }
  // Env var fallback
  const dbPath = process.env.STATE_DB_PATH
  if (dbPath) {
    const stores = createSqliteStores(dbPath)
    return { runStore: stores.runStore, effectStore: stores.effectStore, close: stores.close }
  }
  return { runStore: createRunStore(), effectStore: createEffectStore() }
}

/**
 * Create a new engine instance with the given options.
 *
 * The engine is a long-lived runtime designed to be embedded in your application
 * process (e.g. alongside an HTTP server). It stays active as long as the host
 * process runs, listening for events, dispatching handlers, and heartbeating
 * leases. The dispatcher, heartbeat timer, and lease loop keep the Node.js event
 * loop alive while there is active work.
 *
 * For script-style usage where the process should exit after work completes,
 * call {@link Engine.drain} to wait for all runs, then {@link Engine.stop} to
 * tear down timers. Enabling the {@link EngineOptions.server | dev server} also
 * holds the process open until explicitly stopped.
 *
 * Storage backend is selected based on the `store` option, the `STATE_DB_PATH`
 * environment variable, or defaults to in-memory.
 *
 * @param opts - Engine configuration options.
 * @returns A fully initialized {@link Engine} instance.
 *
 * @example
 * ```ts
 * import { createEngine } from '@yellatech/engine'
 *
 * const engine = createEngine({ concurrency: 5 })
 *
 * engine.register('greet', 'user.signup', async (ctx) => {
 *   console.log(`Welcome, ${ctx.payload.name}!`)
 *   return { success: true }
 * })
 *
 * engine.emit('user.signup', { name: 'Alice' })
 * await engine.drain()
 * await engine.stop()
 * ```
 */
export function createEngine(opts: EngineOptions = {}): Engine {
  const concurrency = opts.concurrency ?? 10
  const maxChainDepth = opts.maxChainDepth ?? 10
  const maxPayloadBytes = opts.maxPayloadBytes ?? 1_048_576
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? 30_000
  const leaseTimeoutMs = opts.leaseTimeoutMs ?? 30_000
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? Math.floor(leaseTimeoutMs / 3)
  if (heartbeatIntervalMs >= leaseTimeoutMs) {
    throw new EngineError(ErrorCode.INVALID_CONFIG, `heartbeatIntervalMs (${heartbeatIntervalMs}) must be less than leaseTimeoutMs (${leaseTimeoutMs})`)
  }
  const leaseOwner = crypto.randomUUID()

  const registry = createRegistry()
  const { runStore, effectStore, close } = buildStores(opts)
  const bus = createBus(registry, runStore, {
    maxChainDepth,
    maxPayloadBytes,
    handlerTimeoutMs,
    effectStore,
    defaultRetry: opts.retry,
    onRetry: opts.onRetry,
    onDead: opts.onDead,
    onRunStart: opts.onRunStart,
    onRunFinish: opts.onRunFinish,
    onRunError: opts.onRunError,
    onInternalError: opts.onInternalError,
  })
  const dispatcher = createDispatcher(runStore, bus.executeRun, concurrency, { leaseOwner, leaseTimeoutMs, heartbeatIntervalMs }, opts.onInternalError)
  let acceptingEvents = true

  // Start dev server in background if configured
  let serverPromise: Promise<DevServer> | null = null
  if (opts.server) {
    const serverOpts = opts.server
    serverPromise = import('./server/index.js').then(async ({ createDevServer }) => {
      const raw = await createDevServer(engine, serverOpts)
      return {
        ...raw,
        stop: async () => {
          await raw.stop()
          serverPromise = null
        },
      }
    })
  }

  // Resume any idle runs left from a previous crash (deferred so handlers can be registered first)
  queueMicrotask(() => {
    // Reclaim runs with expired leases from crashed workers
    try {
      const reclaimed = runStore.reclaimStale()
      for (const run of reclaimed) {
        const retryPolicy = registry.getByEvent(run.eventName).find((d) => d.name === run.processName)?.retry ?? opts.retry

        if (retryPolicy && run.attempt > retryPolicy.maxRetries) {
          // Retry budget exhausted, transition to errored
          runStore.transition(run.id, 'running')
          const error = 'lease expired, retry budget exhausted'
          runStore.setResult(run.id, { success: false, error, errorCode: ErrorCode.LEASE_EXPIRED })
          runStore.transition(run.id, 'errored', { error })
          const errored = runStore.get(run.id)!
          safeCallHook(opts.onDead, [errored, error], opts.onInternalError, 'onDead')
        } else {
          safeCallHook(opts.onRetry, [run, 'lease expired', run.attempt - 1], opts.onInternalError, 'onRetry')
        }
      }
    } catch (err) {
      opts.onInternalError?.(err, 'reclaimStale')
    }
    dispatcher.kick()
  })

  type RegisterOpts = { retry?: RetryPolicy; version?: string; singleton?: boolean; emits?: string[] }

  function register(name: string, eventName: string, handler: Handler, opts?: RegisterOpts): void
  function register<T>(
    name: string,
    eventName: string,
    schema: Schema<T>,
    handler: (ctx: HandlerContext<T>) => Promise<HandlerResult> | HandlerResult,
    opts?: RegisterOpts,
  ): void
  function register(
    name: string,
    eventName: string,
    schemaOrHandler: Schema | Handler,
    maybeHandlerOrOpts?: Handler | RegisterOpts,
    maybeOpts?: RegisterOpts,
  ): void {
    if (typeof maybeHandlerOrOpts === 'function') {
      registry.register(name, eventName, schemaOrHandler as Schema, maybeHandlerOrOpts, maybeOpts)
    } else {
      registry.register(name, eventName, schemaOrHandler as Handler, maybeHandlerOrOpts)
    }
  }

  function unregister(name: string): void {
    registry.unregister(name)
  }

  function emit(eventName: string, payload: unknown, emitOpts?: { idempotencyKey?: string }): Run[] {
    if (!acceptingEvents) return []
    const runs = bus.enqueue(eventName, payload, null, undefined, undefined, emitOpts?.idempotencyKey)
    dispatcher.kick()
    return runs
  }

  function getRunning(): Run[] {
    return runStore.getByState('running')
  }

  function getCompleted(): Run[] {
    return runStore.getByState('completed')
  }

  function getErrored(): Run[] {
    return runStore.getByState('errored')
  }

  function getIdle(): Run[] {
    return runStore.getByState('idle')
  }

  function getRun(id: string): Run | null {
    return runStore.get(id)
  }

  function getChain(runId: string): Run[] {
    return runStore.getChain(runId)
  }

  function getProcesses(): ProcessDefinition[] {
    return registry.getAll()
  }

  function getEffects(runId: string): EffectRecord[] {
    return effectStore.getEffects(runId)
  }

  function retryRun(runId: string): Run {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'errored') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot retry run in state: ${run.state}`)
    runStore.prepareRetry(runId, 0) // retryAfter=0 means immediately
    const updated = runStore.transition(runId, 'idle', { error: 'manual retry' })
    dispatcher.kick()
    return updated
  }

  function requeueDead(runId: string): Run {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'errored') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot requeue run in state: ${run.state}`)
    runStore.resetAttempt(runId)
    const updated = runStore.transition(runId, 'idle', { error: 'requeued from dead letter' })
    dispatcher.kick()
    return updated
  }

  function cancelRun(runId: string): Run {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'idle' && run.state !== 'running') {
      throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot cancel run in state: ${run.state}`)
    }
    runStore.setResult(runId, { success: false, error: 'cancelled' })
    return runStore.transition(runId, 'errored', { error: 'cancelled' })
  }

  function resume(runId: string, payload?: unknown): Run[] {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'completed') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot resume run in state: ${run.state}`)
    if (!run.result?.triggerEvent) throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Run has no triggerEvent to resume`)
    if (!run.result?.deferred) throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Run is not deferred`)
    const mergedPayload = payload !== undefined ? { ...(run.result.payload as any), ...payload } : run.result.payload
    const runs = bus.enqueue(run.result.triggerEvent, mergedPayload, run.id, run.correlationId, run.context)
    runStore.setResult(runId, { ...run.result, deferred: false })
    dispatcher.kick()
    return runs
  }

  function getServer(): Promise<DevServer> | null {
    return serverPromise
  }

  async function stop(stopOpts?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    acceptingEvents = false
    dispatcher.stop()
    if (serverPromise) {
      const server = await serverPromise
      await server.stop()
      serverPromise = null
    }
    if (stopOpts?.graceful) {
      const timeout = stopOpts.timeoutMs ?? 30_000
      await Promise.race([
        dispatcher.waitForActive(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new EngineError(ErrorCode.GRACEFUL_STOP_TIMEOUT, `graceful stop timed out after ${timeout}ms`)), timeout)),
      ])
    }
    close?.()
  }

  async function drain(timeoutMs = 30_000): Promise<void> {
    const idle = runStore.getByState('idle')
    const running = runStore.getByState('running')
    if (idle.length === 0 && running.length === 0) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new EngineError(ErrorCode.DRAIN_TIMEOUT, `drain timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      dispatcher.onDrain(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  function on(eventName: string, handler: Handler): string {
    const name = `_auto_${crypto.randomUUID().slice(0, 8)}`
    register(name, eventName, handler)
    return name
  }

  function registerMany(defs: { name: string; event: string; handler: Handler; schema?: Schema; retry?: RetryPolicy }[]): void {
    for (const def of defs) {
      const retryOpts = def.retry ? { retry: def.retry } : undefined
      if (def.schema) {
        register(def.name, def.event, def.schema, def.handler as any, retryOpts)
      } else {
        register(def.name, def.event, def.handler, retryOpts)
      }
    }
  }

  async function emitAndWait(eventName: string, payload: unknown, emitOpts?: { idempotencyKey?: string; timeoutMs?: number }): Promise<Run[]> {
    const runs = emit(eventName, payload, emitOpts)
    if (runs.length > 0) await drain(emitOpts?.timeoutMs)
    return runs.map((r) => getRun(r.id) ?? r)
  }

  function process<T>(config: ProcessDefinitionConfig<T>): void {
    const { name, on: eventName, schema, retry: retryPolicy, version, singleton, run } = config

    const handler = async (ctx: HandlerContext<T>): Promise<HandlerResult> => {
      const processCtx: ProcessContext<T> = {
        event: ctx.event,
        payload: ctx.payload,
        runId: ctx.runId,
        correlationId: ctx.correlationId,
        context: ctx.context,
        setContext: ctx.setContext,
        effect: ({ key, run: fn }) => {
          const effectKey = Array.isArray(key) ? `arr:v1:${JSON.stringify(key)}` : `str:${key}`
          return ctx.effect(effectKey, fn)
        },
        ok: (payload?, opts?) => ({
          success: true as const,
          ...(payload !== undefined && { payload }),
          ...(opts?.emit && { triggerEvent: opts.emit }),
        }),
        fail: (error, code?) => ({
          success: false as const,
          error,
          ...(code && { errorCode: code }),
        }),
      }
      return run(processCtx)
    }

    const opts = { ...(retryPolicy && { retry: retryPolicy }), ...(version && { version }), ...(singleton && { singleton }), ...(config.emits && config.emits.length > 0 && { emits: config.emits }) }
    if (schema) {
      register(name, eventName, schema, handler as any, Object.keys(opts).length ? opts : undefined)
    } else {
      register(name, eventName, handler as Handler, Object.keys(opts).length ? opts : undefined)
    }
  }

  function getGraph(): EventGraph {
    const processes = registry.getAll()
    const nodes: EventGraphNode[] = processes.map((p) => ({
      name: p.name,
      on: p.eventName,
      emits: p.emits ?? [],
    }))
    const edges: EventGraphEdge[] = []

    for (const p of processes) {
      if (!p.emits) continue
      for (const emitted of p.emits) {
        const targets = registry.getByEvent(emitted)
        for (const target of targets) {
          edges.push({ from: p.name, event: emitted, to: target.name })
        }
      }
    }

    return { nodes, edges }
  }

  const engine: Engine = {
    register,
    unregister,
    process,
    emit,
    on,
    registerMany,
    emitAndWait,
    getRunning,
    getCompleted,
    getErrored,
    getIdle,
    getRun,
    getChain,
    getProcesses,
    getEffects,
    getGraph,
    retryRun,
    requeueDead,
    cancelRun,
    resume,
    stop,
    drain,
    getServer,
  }

  return engine
}
