import { Hono } from 'hono'
import type { Engine } from '../types.js'
import { buildTraceTree, flattenTrace } from './trace.js'

export function registerRoutes(app: Hono, engine: Engine) {
  app.get('/health', (c) => {
    const running = engine.getRunning()
    const idle = engine.getIdle()
    const errored = engine.getErrored()
    const completed = engine.getCompleted()
    const processes = engine.getProcesses()

    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      queue: {
        running: running.length,
        idle: idle.length,
        completed: completed.length,
        errored: errored.length,
      },
      processes: processes.map((p) => ({
        name: p.name,
        event: p.eventName,
      })),
    })
  })

  app.get('/runs', (c) => {
    const state = c.req.query('state')
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200)
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)

    let runs
    switch (state) {
      case 'running':
        runs = engine.getRunning()
        break
      case 'completed':
        runs = engine.getCompleted()
        break
      case 'errored':
        runs = engine.getErrored()
        break
      case 'idle':
        runs = engine.getIdle()
        break
      default:
        runs = [...engine.getRunning(), ...engine.getIdle(), ...engine.getCompleted(), ...engine.getErrored()]
    }

    if (c.req.query('root') === 'true') {
      runs = runs.filter((r) => r.parentRunId === null)
    }

    runs.sort((a, b) => b.startedAt - a.startedAt)

    return c.json({ runs: runs.slice(offset, offset + limit), total: runs.length, offset })
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

  app.post('/emit', async (c) => {
    const body = await c.req.json<{ event?: string; payload?: unknown; idempotencyKey?: string }>()
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
