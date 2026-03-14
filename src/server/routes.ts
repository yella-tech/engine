import { Hono } from 'hono'
import type { Context } from 'hono'
import { parseDurationMs } from '../util.js'
import type { ProcessState, RunStatus } from '../types.js'
import type { RoutableEngine } from './contract.js'
import { createEngineRouteServices } from './engine-services.js'

export type { RoutableEngine } from './contract.js'

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function rejectCrossOriginMutation(c: Context): Response | null {
  const origin = c.req.header('origin')
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'Cross-origin mutation requests are not allowed' }, 403)
      }
    } catch {
      return c.json({ error: 'Cross-origin mutation requests are not allowed' }, 403)
    }
    return null
  }

  const fetchSite = c.req.header('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return c.json({ error: 'Cross-origin mutation requests are not allowed' }, 403)
  }

  return null
}

/**
 * Register the engine HTTP API onto a Hono app.
 *
 * Responses expose both raw `state` and derived `status` where relevant so
 * operator UIs can distinguish cases like `completed` vs `deferred` and
 * `errored` vs `dead-letter`.
 */
export function registerRoutes<T extends Hono>(app: T, engine: RoutableEngine) {
  const services = createEngineRouteServices(engine)

  return app
    .get('/events', (c) => {
      return services.live.stream(c.req.raw.signal)
    })
    .get('/health', (c) => {
      return c.json(services.reads.health())
    })
    .get('/overview', (c) => {
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
      return c.json(
        services.reads.overview({
          root: c.req.query('root') === 'true',
          limit: Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '10', 10) || 10, 100)),
          observabilityWindowMs,
        }),
      )
    })
    .get('/metrics', (c) => {
      return c.json(services.reads.metrics())
    })
    .get('/observability', (c) => {
      const to = parsePositiveInt(c.req.query('to'))
      const from = parsePositiveInt(c.req.query('from'))
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
      return c.json(
        services.reads.observability({
          to,
          from,
          windowMs,
          bucketMs: parsePositiveInt(c.req.query('bucketMs')),
          errorLimit: parsePositiveInt(c.req.query('errorLimit')),
        }),
      )
    })
    .get('/runs', (c) => {
      const state = c.req.query('state') as ProcessState | undefined
      const status = c.req.query('status') as RunStatus | undefined
      const validStates: ProcessState[] = ['running', 'completed', 'errored', 'idle']
      const validStatuses: RunStatus[] = ['running', 'completed', 'errored', 'idle', 'deferred', 'dead-letter']
      return c.json(
        services.reads.runs({
          state: state && validStates.includes(state) ? state : null,
          status: status && validStatuses.includes(status) ? status : null,
          limit: Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 200)),
          offset: Math.max(Number.parseInt(c.req.query('offset') ?? '0', 10) || 0, 0),
          root: c.req.query('root') === 'true',
        }),
      )
    })
    .get('/runs/:id', (c) => {
      const run = services.reads.run(c.req.param('id'))
      if (!run) return c.json({ error: 'Run not found' }, 404)
      return c.json(run)
    })
    .get('/runs/:id/chain', (c) => {
      const chain = services.reads.chain(c.req.param('id'))
      if (!chain) return c.json({ error: 'Run not found' }, 404)
      return c.json(chain)
    })
    .get('/runs/:id/overlay', (c) => {
      const overlay = services.reads.overlay(c.req.param('id'), c.req.query('selectedId'))
      if (!overlay) return c.json({ error: 'Run not found' }, 404)
      return c.json(overlay)
    })
    .get('/runs/:id/trace', (c) => {
      const trace = services.reads.trace(c.req.param('id'))
      if (!trace) return c.json({ error: 'Run not found' }, 404)
      return c.json(trace)
    })
    .get('/runs/:id/effects', (c) => {
      const effects = services.reads.effects(c.req.param('id'))
      if (!effects) return c.json({ error: 'Run not found' }, 404)
      return c.json(effects)
    })
    .post('/runs/:id/retry', (c) => {
      const blocked = rejectCrossOriginMutation(c)
      if (blocked) return blocked
      try {
        return c.json(services.commands.retry(c.req.param('id')))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .post('/runs/:id/requeue', (c) => {
      const blocked = rejectCrossOriginMutation(c)
      if (blocked) return blocked
      try {
        return c.json(services.commands.requeue(c.req.param('id')))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .get('/graph', (c) => {
      return c.json(services.reads.graph())
    })
    .post('/runs/:id/resume', async (c) => {
      const blocked = rejectCrossOriginMutation(c)
      if (blocked) return blocked
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
        return c.json(services.commands.resume(c.req.param('id'), body))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return c.json({ error: message }, 422)
      }
    })
    .post('/emit', async (c) => {
      const blocked = rejectCrossOriginMutation(c)
      if (blocked) return blocked
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
        return c.json(services.commands.emit(event, payload ?? {}, idempotencyKey), 201)
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
