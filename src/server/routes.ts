import { Hono } from 'hono'
import { getRunStatus, withRunStatus, withRunStatuses } from '../status.js'
import type {
  Run,
  ProcessState,
  ProcessDefinition,
  EffectRecord,
  EngineMetrics,
  EngineObservabilityQuery,
  EngineObservabilityReport,
  EngineStreamEvent,
  EventGraph,
  RunStatus,
  EngineEvent,
} from '../types.js'
import { parseDurationMs } from '../util.js'
import { buildTraceGaps, buildTraceTree, flattenTrace } from './trace.js'

/** Minimal engine surface required by {@link registerRoutes}. */
export interface RoutableEngine {
  getRunning(): Run[]
  getIdle(): Run[]
  getCompleted(): Run[]
  getErrored(): Run[]
  getProcesses(): ProcessDefinition[]
  getRun(id: string): Run | null
  getChain(runId: string): Run[]
  getEffects(runId: string): EffectRecord[]
  retryRun(runId: string): Run
  requeueDead(runId: string): Run
  getGraph(): EventGraph
  emit(event: string, payload: unknown, opts?: { idempotencyKey?: string }): Run[]
  resume(runId: string, payload?: unknown): Run[]
  countByState(state: ProcessState): number
  getRunsByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: { root?: boolean; order?: 'asc' | 'desc' }): { runs: Run[]; total: number }
  getRunsPaginated(state: ProcessState | null, limit: number, offset: number, opts?: { root?: boolean; order?: 'asc' | 'desc' }): { runs: Run[]; total: number }
  getMetrics(): EngineMetrics
  getObservability(query?: EngineObservabilityQuery): EngineObservabilityReport
  subscribeEvents(listener: (event: EngineEvent) => void): () => void
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function defaultBucketMsForWindow(windowMs: number): number {
  if (windowMs <= 6 * 60 * 60_000) return 5 * 60_000
  if (windowMs <= 24 * 60 * 60_000) return 60 * 60_000
  if (windowMs <= 7 * 24 * 60 * 60_000) return 6 * 60 * 60_000
  return 24 * 60 * 60_000
}

function toStreamEvent(event: EngineEvent): EngineStreamEvent {
  const at = Date.now()

  switch (event.type) {
    case 'run:start':
    case 'run:complete':
    case 'run:error':
    case 'run:retry':
    case 'run:dead':
      return {
        kind: 'event',
        at,
        topics: ['health', 'runs', 'overview', 'observability', 'trace', 'graph', 'overlay'],
        eventType: event.type,
        runId: event.run.id,
        correlationId: event.run.correlationId,
        processName: event.run.processName,
        eventName: event.run.eventName,
      }

    case 'run:resume':
      return {
        kind: 'event',
        at,
        topics: ['health', 'runs', 'overview', 'observability', 'trace', 'graph', 'overlay'],
        eventType: event.type,
        runId: event.resumedRun.id,
        correlationId: event.resumedRun.correlationId,
        processName: event.resumedRun.processName,
        eventName: event.resumedRun.eventName,
      }

    case 'effect:complete':
    case 'effect:error':
    case 'effect:replay':
      return {
        kind: 'event',
        at,
        topics: ['observability', 'trace', 'overlay'],
        eventType: event.type,
        runId: event.runId,
        effectKey: event.effectKey,
      }

    case 'lease:reclaim':
      return {
        kind: 'event',
        at,
        topics: ['health', 'runs', 'overview', 'observability'],
        eventType: event.type,
        runId: event.run.id,
        correlationId: event.run.correlationId,
        processName: event.run.processName,
        eventName: event.run.eventName,
      }

    case 'internal:error':
      return {
        kind: 'event',
        at,
        topics: ['health', 'overview', 'observability'],
        eventType: event.type,
        context: event.context,
      }
  }
}

function listRunsByStatus(engine: RoutableEngine, status: RunStatus, limit: number, offset: number, opts?: { root?: boolean }) {
  const result = engine.getRunsByStatusPaginated(status, limit, offset, opts)
  return {
    runs: withRunStatuses(result.runs),
    total: result.total,
  }
}

function sortChainRuns(runs: Run[]) {
  return [...runs].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.startedAt - b.startedAt)
}

function resolveRootRun(engine: RoutableEngine, run: Run): Run {
  let current = run
  while (current.parentRunId) {
    const parent = engine.getRun(current.parentRunId)
    if (!parent) break
    current = parent
  }
  return current
}

function buildOverlayPayload(engine: RoutableEngine, runId: string, selectedId?: string) {
  const run = engine.getRun(runId)
  if (!run) return null

  const rootRun = resolveRootRun(engine, run)
  const chain = withRunStatuses(sortChainRuns(engine.getChain(rootRun.id)))
  const selectedRun = chain.find((entry) => entry.id === selectedId) ?? chain.find((entry) => entry.id === run.id) ?? withRunStatus(run)
  const selectedStepIdx = Math.max(
    0,
    chain.findIndex((entry) => entry.id === selectedRun.id),
  )

  return {
    run: withRunStatus(run),
    rootRunId: rootRun.id,
    chain,
    selectedRun,
    selectedStepIdx,
    effects: engine.getEffects(selectedRun.id),
  }
}

/**
 * Register the engine HTTP API onto a Hono app.
 *
 * Responses expose both raw `state` and derived `status` where relevant so
 * operator UIs can distinguish cases like `completed` vs `deferred` and
 * `errored` vs `dead-letter`.
 */
export function registerRoutes<T extends Hono>(app: T, engine: RoutableEngine) {
  return app
    .get('/events', (c) => {
      const encoder = new TextEncoder()
      let unsubscribe: (() => void) | null = null
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let closed = false

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (payload: EngineStreamEvent) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
            } catch {
              cleanup()
            }
          }

          const cleanup = () => {
            if (closed) return
            closed = true
            if (heartbeat) clearInterval(heartbeat)
            heartbeat = null
            unsubscribe?.()
            unsubscribe = null
            try {
              controller.close()
            } catch {
              /* stream already closed */
            }
          }

          send({ kind: 'connected', at: Date.now(), topics: [] })
          unsubscribe = engine.subscribeEvents((event) => {
            send(toStreamEvent(event))
          })
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': keepalive\n\n'))
            } catch {
              cleanup()
            }
          }, 15_000)
          heartbeat.unref?.()
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
        },
        cancel() {
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = null
          unsubscribe?.()
          unsubscribe = null
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      })
    })
    .get('/health', (c) => {
      const metrics = engine.getMetrics()
      return c.json({
        status: 'ok',
        uptime: process.uptime(),
        queue: metrics.queue,
        totals: metrics.totals,
        processes: engine.getProcesses().map((p) => ({ name: p.name, event: p.eventName })),
      })
    })
    .get('/overview', (c) => {
      const metrics = engine.getMetrics()
      const root = c.req.query('root') === 'true'
      const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 100))
      const overviewWindow = c.req.query('observabilityWindow')
      const observabilityWindowMs = overviewWindow
        ? (() => {
            try {
              return parseDurationMs(overviewWindow, 'observabilityWindow')
            } catch {
              return undefined
            }
          })()
        : undefined
      const recentRuns = engine.getRunsPaginated(null, limit, 0, { root })
      const observability = observabilityWindowMs ? engine.getObservability({ from: Math.max(0, Date.now() - observabilityWindowMs), to: Date.now() }) : null

      return c.json({
        health: {
          status: 'ok',
          uptime: process.uptime(),
          queue: metrics.queue,
          totals: metrics.totals,
          processes: engine.getProcesses().map((p) => ({ name: p.name, event: p.eventName })),
        },
        recentRuns: {
          runs: withRunStatuses(recentRuns.runs),
          total: recentRuns.total,
        },
        observability: observability ? { summary: observability.summary } : null,
      })
    })
    .get('/metrics', (c) => {
      return c.json(engine.getMetrics())
    })
    .get('/observability', (c) => {
      const to = parsePositiveInt(c.req.query('to')) ?? Date.now()
      const fromParam = parsePositiveInt(c.req.query('from'))
      const windowParam = c.req.query('window')
      const windowMs = windowParam
        ? (() => {
            try {
              return parseDurationMs(windowParam, 'window')
            } catch {
              return undefined
            }
          })()
        : undefined
      const from = fromParam ?? (windowMs ? Math.max(0, to - windowMs) : undefined)
      const bucketMs = parsePositiveInt(c.req.query('bucketMs')) ?? (windowMs ? defaultBucketMsForWindow(windowMs) : undefined)
      const errorLimit = parsePositiveInt(c.req.query('errorLimit'))
      return c.json(engine.getObservability({ from, to, bucketMs, errorLimit }))
    })
    .get('/runs', (c) => {
      const state = c.req.query('state') as ProcessState | undefined
      const status = c.req.query('status') as RunStatus | undefined
      const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200))
      const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
      const root = c.req.query('root') === 'true'
      const validStates: ProcessState[] = ['running', 'completed', 'errored', 'idle']
      const validStatuses: RunStatus[] = ['running', 'completed', 'errored', 'idle', 'deferred', 'dead-letter']
      const stateParam = state && validStates.includes(state) ? state : null
      const statusParam = status && validStatuses.includes(status) ? status : null
      const result = statusParam
        ? listRunsByStatus(engine, statusParam, limit, offset, { root })
        : (() => {
            const runs = engine.getRunsPaginated(stateParam, limit, offset, { root })
            return { runs: withRunStatuses(runs.runs), total: runs.total }
          })()
      return c.json({ runs: result.runs, total: result.total, offset })
    })
    .get('/runs/:id', (c) => {
      const run = engine.getRun(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)
      return c.json(withRunStatus(run))
    })
    .get('/runs/:id/chain', (c) => {
      const run = engine.getRun(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)
      const chain = engine.getChain(c.req.param('id'))
      return c.json({ runs: withRunStatuses(chain) })
    })
    .get('/runs/:id/overlay', (c) => {
      const data = buildOverlayPayload(engine, c.req.param('id'), c.req.query('selectedId'))
      if (!data) return c.json({ error: 'Run not found' }, 404)
      return c.json(data)
    })
    .get('/runs/:id/trace', (c) => {
      const run = engine.getRun(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const chain = engine.getChain(c.req.param('id'))
      const tree = buildTraceTree(chain)
      const flat = flattenTrace(tree)
      const gaps = buildTraceGaps(chain)

      const timestamps = flat.flatMap((n) => [n.idleAt, n.runningAt, n.completedAt].filter((t): t is number => t !== null))
      const minTime = timestamps.length ? Math.min(...timestamps) : 0
      const maxTime = timestamps.length ? Math.max(...timestamps) : 0
      const executionDurationMs = flat.reduce((total, span) => {
        if (span.runningAt === null || span.completedAt === null) return total
        return total + Math.max(span.completedAt - span.runningAt, 0)
      }, 0)
      const pausedDurationMs = gaps.reduce((total, gap) => total + gap.durationMs, 0)

      return c.json({
        correlationId: run.correlationId,
        minTime,
        maxTime,
        durationMs: maxTime - minTime,
        executionDurationMs,
        pausedDurationMs,
        gaps,
        spans: flat,
      })
    })
    .get('/runs/:id/effects', (c) => {
      const run = engine.getRun(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)
      const effects = engine.getEffects(c.req.param('id'))
      return c.json({ effects })
    })
    .post('/runs/:id/retry', (c) => {
      try {
        const run = engine.retryRun(c.req.param('id'))
        return c.json({ id: run.id, state: run.state, status: getRunStatus(run) })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .post('/runs/:id/requeue', (c) => {
      try {
        const run = engine.requeueDead(c.req.param('id'))
        return c.json({ id: run.id, state: run.state, status: getRunStatus(run) })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .get('/graph', (c) => {
      return c.json(engine.getGraph())
    })
    .post('/runs/:id/resume', async (c) => {
      const id = c.req.param('id')
      let body: unknown
      const contentType = c.req.header('content-type') ?? ''
      if (contentType.includes('application/json')) {
        try {
          body = await c.req.json()
        } catch {
          return c.json({ error: 'Invalid JSON body' }, 400)
        }
      }
      try {
        const runs = engine.resume(id, body)
        return c.json({ resumed: true, runs: runs.map((r) => ({ id: r.id, process: r.processName, state: r.state, status: getRunStatus(r) })) })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .post('/emit', async (c) => {
      let body: { event?: string; payload?: unknown; idempotencyKey?: string }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      const { event, payload, idempotencyKey } = body

      if (!event || typeof event !== 'string') {
        return c.json({ error: 'Missing or invalid "event" field' }, 400)
      }

      try {
        const runs = engine.emit(event, payload ?? {}, idempotencyKey ? { idempotencyKey } : undefined)
        return c.json(
          {
            created: runs.length,
            runs: runs.map((r) => ({ id: r.id, process: r.processName, state: r.state, status: getRunStatus(r) })),
          },
          201,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
}

export function createEngineApi(engine: RoutableEngine, app: Hono = new Hono()) {
  return registerRoutes(app, engine)
}

export type EngineApi = ReturnType<typeof createEngineApi>
