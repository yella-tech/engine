import crypto from 'node:crypto'
import { createBus } from './bus.js'
import { createDispatcher } from './dispatcher.js'
import { createEffectStore } from './effect.js'
import { createEngineObservabilityRecorder, createMemoryEngineObservabilityStore } from './observability-store.js'
import { createRegistry } from './registry.js'
import { createRunStore } from './run.js'
import { createSqliteStores } from './run-sqlite.js'
import { getRunStatus } from './status.js'
import { EngineError, ErrorCode } from './types.js'
import { parseDurationMs, safeCallHook } from './util.js'
import type {
  DevServer,
  EffectRecord,
  EffectStore,
  Engine,
  EngineEvent,
  EngineMetrics,
  EngineObservabilityBucket,
  EngineObservabilityError,
  EngineObservabilityQuery,
  EngineObservabilityReport,
  EngineObservabilitySummary,
  EngineStreamEvent,
  EngineOptions,
  Handler,
  HandlerContext,
  HandlerResult,
  ProcessContext,
  ProcessDefinition,
  ProcessDefinitionConfig,
  ProcessState,
  RunQueryOptions,
  RunSortOrder,
  RunStatus,
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
  DurationHistogram,
  DurationStats,
  EffectFn,
  EffectRecord,
  EffectState,
  EffectStore,
  Engine,
  EngineEvent,
  EngineMetrics,
  EngineObservabilityBucket,
  EngineObservabilityError,
  EngineObservabilityQuery,
  EngineObservabilityReport,
  EngineObservabilitySummary,
  EngineStreamEvent,
  EngineOptions,
  Handler,
  HandlerContext,
  HandlerResult,
  ProcessContext,
  ProcessDefinition,
  ProcessDefinitionConfig,
  ProcessState,
  RunQueryOptions,
  RunSortOrder,
  RunStatus,
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
export type { EngineObservabilityStore } from './observability-store.js'
export { getRunStatus, isDeadLetterRun, isDeferredRun, withRunStatus, withRunStatuses } from './status.js'
export { registerRoutes } from './server/routes.js'
export { defaultBucketMsForWindow } from './server/engine-services.js'
export type { RoutableEngine } from './server/routes.js'
export { serveDashboard, resolveEngineUiDir, createDevServer } from './server/index.js'

function buildStores(opts: EngineOptions): { runStore: RunStore; effectStore: EffectStore; observabilityStore: ReturnType<typeof createMemoryEngineObservabilityStore>; close?: () => void } {
  if (opts.store === 'memory') {
    return { runStore: createRunStore(), effectStore: createEffectStore(), observabilityStore: createMemoryEngineObservabilityStore() }
  }
  if (opts.store) {
    const stores = createSqliteStores(opts.store.path)
    return { runStore: stores.runStore, effectStore: stores.effectStore, observabilityStore: stores.observabilityStore, close: stores.close }
  }
  // Env var fallback
  const dbPath = process.env.STATE_DB_PATH
  if (dbPath) {
    const stores = createSqliteStores(dbPath)
    return { runStore: stores.runStore, effectStore: stores.effectStore, observabilityStore: stores.observabilityStore, close: stores.close }
  }
  return { runStore: createRunStore(), effectStore: createEffectStore(), observabilityStore: createMemoryEngineObservabilityStore() }
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
  let retentionMs: number | null = null
  if (heartbeatIntervalMs >= leaseTimeoutMs) {
    throw new EngineError(ErrorCode.INVALID_CONFIG, `heartbeatIntervalMs (${heartbeatIntervalMs}) must be less than leaseTimeoutMs (${leaseTimeoutMs})`)
  }
  if (opts.retention !== undefined) {
    try {
      retentionMs = parseDurationMs(opts.retention, 'retention')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new EngineError(ErrorCode.INVALID_CONFIG, message)
    }
  }
  const leaseOwner = crypto.randomUUID()

  // ── Observability ──

  const totals = { retries: 0, deadLetters: 0, resumes: 0, leaseReclaims: 0, internalErrors: 0 }
  let observability: ReturnType<typeof createEngineObservabilityRecorder> | null = null
  const subscribers = new Set<(event: EngineEvent) => void>()

  /** Call onInternalError safely without re-emitting events. */
  function notifyInternalError(error: unknown, context: string): void {
    try {
      opts.onInternalError?.(error, context)
    } catch {
      /* safety net */
    }
  }

  /** Report an internal error to metrics, onInternalError, and onEvent without recursing. */
  function reportInternalError(error: unknown, context: string): void {
    totals.internalErrors++
    notifyInternalError(error, context)
    if (observability) {
      try {
        observability.record({ type: 'internal:error', error, context })
      } catch (err) {
        totals.internalErrors++
        notifyInternalError(err, 'observability')
      }
    }
    if (opts.onEvent) {
      try {
        opts.onEvent({ type: 'internal:error', error, context })
      } catch (err) {
        totals.internalErrors++
        notifyInternalError(err, 'onEvent')
      }
    }
    for (const listener of subscribers) {
      try {
        listener({ type: 'internal:error', error, context })
      } catch (err) {
        totals.internalErrors++
        notifyInternalError(err, 'subscribeEvents')
      }
    }
  }

  /** Central event emitter. Never throws. Routes to counters, legacy hooks, and onEvent. */
  function emitEvent(event: EngineEvent): void {
    if (event.type === 'internal:error') {
      reportInternalError(event.error, event.context)
      return
    }

    // 1. Runtime counters
    switch (event.type) {
      case 'run:retry':
        totals.retries++
        break
      case 'run:dead':
        totals.deadLetters++
        break
      case 'run:resume':
        totals.resumes++
        break
      case 'lease:reclaim':
        totals.leaseReclaims++
        break
    }

    // 2. Persisted observability (safe, failures become internal errors)
    if (observability) {
      try {
        observability.record(event)
      } catch (err) {
        reportInternalError(err, 'observability')
      }
    }

    // 3. Legacy hooks (safe, failures go to reportInternalError, not back to emitEvent)
    switch (event.type) {
      case 'run:start':
        safeCallHook(opts.onRunStart, [event.run], reportInternalError, 'onRunStart')
        break
      case 'run:complete':
        safeCallHook(opts.onRunFinish, [event.run], reportInternalError, 'onRunFinish')
        break
      case 'run:error':
        safeCallHook(opts.onRunError, [event.run, event.error], reportInternalError, 'onRunError')
        safeCallHook(opts.onRunFinish, [event.run], reportInternalError, 'onRunFinish')
        break
      case 'run:retry':
        safeCallHook(opts.onRetry, [event.run, event.error, event.attempt], reportInternalError, 'onRetry')
        break
      case 'run:dead':
        safeCallHook(opts.onDead, [event.run, event.error], reportInternalError, 'onDead')
        break
    }

    // 4. Unified onEvent, NOT called recursively for its own failures
    if (opts.onEvent) {
      try {
        opts.onEvent(event)
      } catch (err) {
        totals.internalErrors++
        notifyInternalError(err, 'onEvent')
      }
    }

    for (const listener of subscribers) {
      try {
        listener(event)
      } catch (err) {
        totals.internalErrors++
        notifyInternalError(err, 'subscribeEvents')
      }
    }
  }

  // ── Core wiring ──

  const registry = createRegistry()
  const { runStore, effectStore, observabilityStore, close } = buildStores(opts)
  observability = createEngineObservabilityRecorder({
    store: observabilityStore,
    lookupRun: (runId) => runStore.get(runId),
  })
  const bus = createBus(registry, runStore, {
    maxChainDepth,
    maxPayloadBytes,
    handlerTimeoutMs,
    leaseOwner,
    effectStore,
    defaultRetry: opts.retry,
    emitEvent,
  })
  const dispatcher = createDispatcher(runStore, bus.executeRun, concurrency, { leaseOwner, leaseTimeoutMs, heartbeatIntervalMs }, reportInternalError, (runId, message) =>
    bus.abortRun(runId, 'lease', message),
  )
  let acceptingEvents = true
  let runtimeStarted = false
  let retentionTimer: ReturnType<typeof setInterval> | null = null

  function pruneExpiredRuns(): string[] {
    if (retentionMs === null || !runStore.pruneCompletedBefore) return []
    const prunedRunIds = runStore.pruneCompletedBefore(Date.now() - retentionMs)
    if (prunedRunIds.length > 0) {
      effectStore.deleteEffectsForRuns(prunedRunIds)
    }
    return prunedRunIds
  }

  if (retentionMs !== null) {
    const sweepIntervalMs = Math.min(Math.max(Math.floor(retentionMs / 2), 10), 60_000)
    queueMicrotask(() => {
      try {
        pruneExpiredRuns()
      } catch (err) {
        reportInternalError(err, 'retention')
      }
    })
    retentionTimer = setInterval(() => {
      try {
        pruneExpiredRuns()
      } catch (err) {
        reportInternalError(err, 'retention')
      }
    }, sweepIntervalMs)
    retentionTimer.unref?.()
  }

  // Start dev server in background if configured
  let serverPromise: Promise<DevServer> | null = null
  if (opts.server) {
    const serverOpts = opts.server
    serverPromise = import('./server/index.js').then(async ({ createDevServer, serveDashboard, resolveEngineUiDir }) => {
      const raw = createDevServer(engine, { dashboardFallback: false })
      serveDashboard(raw.app, resolveEngineUiDir())
      await raw.serve({ host: serverOpts.host, port: serverOpts.port })
      return {
        ...raw,
        stop: async () => {
          await raw.stop()
          serverPromise = null
        },
      }
    })
  }

  function start(): void {
    if (runtimeStarted || !acceptingEvents) return
    runtimeStarted = true
    try {
      const reclaimed = runStore.reclaimStale()
      for (const run of reclaimed) {
        emitEvent({ type: 'lease:reclaim', run })
        const retryPolicy = registry.getByEvent(run.eventName).find((d) => d.name === run.processName)?.retry ?? opts.retry

        if (retryPolicy && run.attempt > retryPolicy.maxRetries) {
          runStore.transition(run.id, 'running')
          const error = 'lease expired, retry budget exhausted'
          runStore.setResult(run.id, { success: false, error, errorCode: ErrorCode.LEASE_EXPIRED })
          runStore.transition(run.id, 'errored', { error, event: 'dead-letter' })
          const errored = runStore.get(run.id)!
          emitEvent({ type: 'run:dead', run: errored, error })
          emitEvent({ type: 'run:error', run: errored, error, durationMs: 0 })
        } else {
          emitEvent({ type: 'run:retry', run, error: 'lease expired', attempt: run.attempt - 1 })
        }
      }
    } catch (err) {
      emitEvent({ type: 'internal:error', error: err, context: 'reclaimStale' })
    }
    dispatcher.kick()
  }

  type RegisterOpts = { retry?: RetryPolicy; version?: string; singleton?: boolean; emits?: string[] }

  function register(name: string, eventName: string, handler: Handler, opts?: RegisterOpts): void
  function register<T>(name: string, eventName: string, schema: Schema<T>, handler: (ctx: HandlerContext<T>) => Promise<HandlerResult> | HandlerResult, opts?: RegisterOpts): void
  function register(name: string, eventName: string, schemaOrHandler: Schema | Handler, maybeHandlerOrOpts?: Handler | RegisterOpts, maybeOpts?: RegisterOpts): void {
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
    start()
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

  function countByState(state: ProcessState): number {
    if (runStore.countByState) return runStore.countByState(state)
    return runStore.getByState(state).length
  }

  function getRunsByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    if (runStore.getByStatusPaginated) return runStore.getByStatusPaginated(status, limit, offset, opts)
    let runs =
      status === 'completed'
        ? runStore.getByState('completed').filter((run) => getRunStatus(run) === 'completed')
        : status === 'errored'
          ? runStore.getByState('errored').filter((run) => getRunStatus(run) === 'errored')
          : status === 'deferred'
            ? runStore.getByState('completed').filter((run) => getRunStatus(run) === 'deferred')
            : status === 'dead-letter'
              ? runStore.getByState('errored').filter((run) => getRunStatus(run) === 'dead-letter')
              : runStore.getByState(status)
    if (opts?.root) runs = runs.filter((r) => r.parentRunId === null)
    if (opts?.eventName) runs = runs.filter((r) => r.eventName === opts.eventName)
    const order = opts?.order ?? 'desc'
    runs.sort((a, b) => (order === 'asc' ? a.startedAt - b.startedAt : b.startedAt - a.startedAt))
    return { runs: runs.slice(offset, offset + limit), total: runs.length }
  }

  function getRunsPaginated(state: ProcessState | null, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    if (runStore.getByStatePaginated) return runStore.getByStatePaginated(state, limit, offset, opts)
    let runs = state ? runStore.getByState(state) : runStore.getAll()
    if (opts?.root) runs = runs.filter((r) => r.parentRunId === null)
    if (opts?.eventName) runs = runs.filter((r) => r.eventName === opts.eventName)
    const order = opts?.order ?? 'desc'
    runs.sort((a, b) => (order === 'asc' ? a.startedAt - b.startedAt : b.startedAt - a.startedAt))
    return { runs: runs.slice(offset, offset + limit), total: runs.length }
  }

  function retryRun(runId: string): Run {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'errored') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot retry run in state: ${run.state}`)
    start()
    effectStore.clearStartedEffects(runId)
    runStore.prepareRetry(runId, 0) // retryAfter=0 means immediately
    const updated = runStore.transition(runId, 'idle', { error: 'manual retry' })
    dispatcher.kick()
    return updated
  }

  function requeueDead(runId: string): Run {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (getRunStatus(run) !== 'dead-letter') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot requeue run in status: ${getRunStatus(run)}`)
    start()
    effectStore.clearStartedEffects(runId)
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
    const cancelled = runStore.transition(runId, 'errored', { error: 'cancelled' })
    bus.abortRun(runId, 'cancel', 'run cancelled')
    return cancelled
  }

  function resume(runId: string, payload?: unknown): Run[] {
    const run = runStore.get(runId)
    if (!run) throw new EngineError(ErrorCode.RUN_NOT_FOUND, `Run not found: ${runId}`)
    if (run.state !== 'completed') throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Cannot resume run in state: ${run.state}`)
    if (!run.result?.triggerEvent) throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Run has no triggerEvent to resume`)
    if (!run.result?.deferred) throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Run is not deferred`)
    start()
    const mergedPayload =
      payload !== undefined && typeof payload === 'object' && payload !== null && typeof run.result.payload === 'object' && run.result.payload !== null
        ? { ...(run.result.payload as any), ...(payload as any) }
        : payload !== undefined
          ? payload
          : run.result.payload
    const childRuns = bus.enqueue(run.result.triggerEvent, mergedPayload, run.id, run.correlationId, run.context)
    if (childRuns.length === 0) {
      throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Deferred run did not create any child runs: ${runId}`)
    }
    runStore.setResult(runId, { ...run.result, deferred: false })
    emitEvent({ type: 'run:resume', resumedRun: runStore.get(runId)!, childRuns })
    dispatcher.kick()
    return childRuns
  }

  function getServer(): Promise<DevServer> | null {
    return serverPromise
  }

  async function stop(stopOpts?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    acceptingEvents = false
    dispatcher.pause()
    if (stopOpts?.graceful) {
      const timeout = stopOpts.timeoutMs ?? 30_000
      await Promise.race([
        dispatcher.waitForActive(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new EngineError(ErrorCode.GRACEFUL_STOP_TIMEOUT, `graceful stop timed out after ${timeout}ms`)), timeout)),
      ])
    } else {
      bus.abortAll('stop', 'engine stopped')
      await dispatcher.waitForActive()
    }
    dispatcher.stop()
    if (retentionTimer) {
      clearInterval(retentionTimer)
      retentionTimer = null
    }
    if (serverPromise) {
      const server = await serverPromise
      await server.stop()
      serverPromise = null
    }
    observability?.close()
    observability = null
    close?.()
  }

  async function drain(timeoutMs = 30_000): Promise<void> {
    start()
    const hasWork = runStore.hasState ? runStore.hasState('idle') || runStore.hasState('running') : runStore.getByState('idle').length > 0 || runStore.getByState('running').length > 0
    if (!hasWork) return

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
    if (runs.length > 0) {
      const rootRunIds = runs.map((run) => run.id)
      const timeoutMs = emitOpts?.timeoutMs ?? 30_000
      const isChainTerminal = (runId: string) => {
        const chain = getChain(runId)
        if (chain.length === 0) return false
        return chain.every((entry) => {
          const status = getRunStatus(entry)
          return status === 'completed' || status === 'errored' || status === 'dead-letter' || status === 'deferred'
        })
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval)
          reject(new EngineError(ErrorCode.DRAIN_TIMEOUT, `drain timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        const interval = setInterval(() => {
          if (rootRunIds.every(isChainTerminal)) {
            clearTimeout(timeout)
            clearInterval(interval)
            resolve()
          }
        }, 5)

        if (rootRunIds.every(isChainTerminal)) {
          clearTimeout(timeout)
          clearInterval(interval)
          resolve()
        }
      })
    }
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
        signal: ctx.signal,
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

  function getMetrics(): EngineMetrics {
    return {
      queue: {
        idle: countByState('idle'),
        running: countByState('running'),
        completed: countByState('completed'),
        errored: countByState('errored'),
      },
      totals: { ...totals },
    }
  }

  function getObservability(query?: EngineObservabilityQuery): EngineObservabilityReport {
    return (
      observability?.getObservability(query) ?? {
        from: query?.from ?? Date.now(),
        to: query?.to ?? Date.now(),
        bucketSizeMs: query?.bucketMs ?? 5 * 60_000,
        summary: {
          runs: {
            started: 0,
            completed: 0,
            failed: 0,
            retried: 0,
            deadLetters: 0,
            resumed: 0,
            successRate: null,
            duration: {
              count: 0,
              sumMs: 0,
              minMs: null,
              maxMs: null,
              avgMs: null,
              p50Ms: null,
              p95Ms: null,
              histogram: {
                le10ms: 0,
                le50ms: 0,
                le100ms: 0,
                le250ms: 0,
                le500ms: 0,
                le1000ms: 0,
                le2500ms: 0,
                le5000ms: 0,
                le10000ms: 0,
                gt10000ms: 0,
              },
            },
          },
          effects: {
            completed: 0,
            failed: 0,
            replayed: 0,
            successRate: null,
            duration: {
              count: 0,
              sumMs: 0,
              minMs: null,
              maxMs: null,
              avgMs: null,
              p50Ms: null,
              p95Ms: null,
              histogram: {
                le10ms: 0,
                le50ms: 0,
                le100ms: 0,
                le250ms: 0,
                le500ms: 0,
                le1000ms: 0,
                le2500ms: 0,
                le5000ms: 0,
                le10000ms: 0,
                gt10000ms: 0,
              },
            },
          },
          system: { leaseReclaims: 0, internalErrors: 0, recentErrorCount: 0 },
        },
        buckets: [],
        recentErrors: [],
      }
    )
  }

  function subscribeEvents(listener: (event: EngineEvent) => void): () => void {
    subscribers.add(listener)
    return () => {
      subscribers.delete(listener)
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
    start,
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
    countByState,
    getRunsByStatusPaginated,
    getRunsPaginated,
    getMetrics,
    getObservability,
    subscribeEvents,
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
