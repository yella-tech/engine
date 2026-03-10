import { Hono } from 'hono'
import type { Run, ProcessState, ProcessDefinition, EffectRecord, EngineMetrics, EventGraph } from '../types.js'
import { buildTraceTree, flattenTrace } from './trace.js'

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
  getRunsPaginated(state: ProcessState | null, limit: number, offset: number, opts?: { root?: boolean }): { runs: Run[]; total: number }
  getMetrics(): EngineMetrics
}

export function registerRoutes(app: Hono, engine: RoutableEngine) {
  app.get('/health', (c) => {
    const metrics = engine.getMetrics()
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      queue: metrics.queue,
      totals: metrics.totals,
      processes: engine.getProcesses().map((p) => ({ name: p.name, event: p.eventName })),
    })
  })

  app.get('/metrics', (c) => {
    return c.json(engine.getMetrics())
  })

  app.get('/runs', (c) => {
    const state = c.req.query('state') as ProcessState | undefined
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200))
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)
    const root = c.req.query('root') === 'true'
    const validStates: ProcessState[] = ['running', 'completed', 'errored', 'idle']
    const stateParam = state && validStates.includes(state) ? state : null
    const result = engine.getRunsPaginated(stateParam, limit, offset, { root })
    return c.json({ runs: result.runs, total: result.total, offset })
  })

  app.get('/runs/:id', (c) => {
    const run = engine.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Run not found' }, 404)
    return c.json(run)
  })

  app.get('/runs/:id/chain', (c) => {
    const run = engine.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Run not found' }, 404)
    const chain = engine.getChain(c.req.param('id'))
    return c.json({ runs: chain })
  })

  app.get('/runs/:id/trace', (c) => {
    const run = engine.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Run not found' }, 404)

    const chain = engine.getChain(c.req.param('id'))
    const tree = buildTraceTree(chain)
    const flat = flattenTrace(tree)

    const timestamps = flat.flatMap((n) => [n.idleAt, n.runningAt, n.completedAt].filter((t): t is number => t !== null))
    const minTime = timestamps.length ? Math.min(...timestamps) : 0
    const maxTime = timestamps.length ? Math.max(...timestamps) : 0

    return c.json({
      correlationId: run.correlationId,
      minTime,
      maxTime,
      durationMs: maxTime - minTime,
      spans: flat,
    })
  })

  app.get('/runs/:id/effects', (c) => {
    const run = engine.getRun(c.req.param('id'))
    if (!run) return c.json({ error: 'Run not found' }, 404)
    const effects = engine.getEffects(c.req.param('id'))
    return c.json({ effects })
  })

  app.post('/runs/:id/retry', (c) => {
    try {
      const run = engine.retryRun(c.req.param('id'))
      return c.json({ id: run.id, state: run.state })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }
  })

  app.post('/runs/:id/requeue', (c) => {
    try {
      const run = engine.requeueDead(c.req.param('id'))
      return c.json({ id: run.id, state: run.state })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }
  })

  app.get('/graph', (c) => {
    return c.json(engine.getGraph())
  })

  app.post('/runs/:id/resume', async (c) => {
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
      return c.json({ resumed: true, runs: runs.map((r) => ({ id: r.id, process: r.processName, state: r.state })) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }
  })

  app.post('/emit', async (c) => {
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
          runs: runs.map((r) => ({ id: r.id, process: r.processName, state: r.state })),
        },
        201,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 422)
    }
  })
}
