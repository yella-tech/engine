import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createEngine } from './index.js'
import { registerRoutes } from './server/routes.js'
import type { Engine, EngineOptions } from './types.js'

// ── Route parity tests (memory + SQLite) ──

function routeTests(label: string, opts: EngineOptions) {
  describe(`routes (${label})`, () => {
    let engine: Engine
    let app: Hono

    function setup(engineOpts?: Partial<EngineOptions>) {
      engine = createEngine({ ...opts, ...engineOpts })
      app = new Hono()
      registerRoutes(app, engine)
    }

    afterEach(async () => {
      await engine?.stop()
    })

    it('GET /health returns queue stats', async () => {
      setup()
      engine.register('greet', 'hello', async () => ({ success: true }))
      const res = await app.request('/health')
      const data = await res.json()
      expect(data.status).toBe('ok')
      expect(data.queue).toBeDefined()
      expect(data.processes).toHaveLength(1)
    })

    it('GET /observability returns summary and buckets', async () => {
      setup()
      engine.register('proc', 'go', async (ctx) => {
        await ctx.effect('obs', async () => 'done')
        return { success: true }
      })
      engine.emit('go', {})
      await engine.drain()

      const res = await app.request('/observability?window=1h')
      const data = await res.json()
      expect(data.summary.runs.completed).toBe(1)
      expect(data.summary.effects.completed).toBe(1)
      expect(data.buckets.length).toBeGreaterThanOrEqual(1)
      expect(typeof data.bucketSizeMs).toBe('number')
    })

    it('GET /overview returns health and recent runs in one payload', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      const res = await app.request('/overview?limit=10&root=true&observabilityWindow=24h')
      const data = await res.json()
      expect(data.health.status).toBe('ok')
      expect(data.recentRuns.total).toBe(1)
      expect(data.recentRuns.runs).toHaveLength(1)
      expect(data.observability.summary.runs.completed).toBe(1)
    })

    it('GET /events streams connected and lifecycle invalidation events', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))

      const res = await app.request('/events')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()

      const firstChunk = await reader.read()
      expect(decoder.decode(firstChunk.value)).toContain('"kind":"connected"')

      engine.emit('go', {})

      const nextChunk = await reader.read()
      const nextText = decoder.decode(nextChunk.value)
      expect(nextText).toContain('"kind":"event"')
      expect(nextText).toContain('"eventType":"run:start"')

      await reader.cancel()
      await engine.drain()
    })

    it('GET /runs returns runs by state', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', { x: 1 })
      await engine.drain()

      const res = await app.request('/runs?state=completed')
      const data = await res.json()
      expect(data.runs).toHaveLength(1)
      expect(data.runs[0].state).toBe('completed')
    })

    it('GET /runs exposes raw state and derived status', async () => {
      setup()
      engine.register('approve', 'start', async () => ({ success: true, triggerEvent: 'approved', deferred: true }))
      engine.emit('start', {})
      await engine.drain()

      const res = await app.request('/runs')
      const data = await res.json()
      expect(data.runs).toHaveLength(1)
      expect(data.runs[0].state).toBe('completed')
      expect(data.runs[0].status).toBe('deferred')
    })

    it('GET /runs?status filters deferred separately from completed', async () => {
      setup()
      engine.register('approve', 'approval:start', async () => ({ success: true, triggerEvent: 'approval:done', deferred: true }))
      engine.register('finish', 'finish', async () => ({ success: true }))
      engine.emit('approval:start', {})
      engine.emit('finish', {})
      await engine.drain()

      const deferredRes = await app.request('/runs?status=deferred')
      const deferredData = await deferredRes.json()
      expect(deferredData.total).toBe(1)
      expect(deferredData.runs).toHaveLength(1)
      expect(deferredData.runs[0].state).toBe('completed')
      expect(deferredData.runs[0].status).toBe('deferred')

      const completedRes = await app.request('/runs?status=completed')
      const completedData = await completedRes.json()
      expect(completedData.total).toBe(1)
      expect(completedData.runs).toHaveLength(1)
      expect(completedData.runs[0].status).toBe('completed')
    })

    it('GET /runs?status filters dead-letter separately from errored', async () => {
      setup()
      engine.register(
        'dead',
        'dead',
        async () => {
          throw new Error('fatal')
        },
        { retry: { maxRetries: 0, delay: 0 } },
      )
      engine.register('error', 'error', async () => ({ success: false, error: 'plain error' }))
      engine.emit('dead', {})
      engine.emit('error', {})
      await engine.drain()

      const deadRes = await app.request('/runs?status=dead-letter')
      const deadData = await deadRes.json()
      expect(deadData.total).toBe(1)
      expect(deadData.runs).toHaveLength(1)
      expect(deadData.runs[0].state).toBe('errored')
      expect(deadData.runs[0].status).toBe('dead-letter')

      const erroredRes = await app.request('/runs?status=errored')
      const erroredData = await erroredRes.json()
      expect(erroredData.total).toBe(1)
      expect(erroredData.runs).toHaveLength(1)
      expect(erroredData.runs[0].status).toBe('errored')
    })

    it('GET /runs returns paginated results', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', { a: 1 })
      engine.emit('go', { a: 2 })
      engine.emit('go', { a: 3 })
      await engine.drain()

      const res = await app.request('/runs?limit=2')
      const data = await res.json()
      expect(data.runs).toHaveLength(2)
      expect(data.total).toBe(3)
    })

    it('GET /runs clamps negative limit to 1', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', { a: 1 })
      engine.emit('go', { a: 2 })
      engine.emit('go', { a: 3 })
      await engine.drain()

      const res = await app.request('/runs?limit=-1')
      const data = await res.json()
      expect(data.runs).toHaveLength(1)
    })

    it('GET /runs clamps limit=0 to default', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      engine.emit('go', {})
      await engine.drain()

      const res = await app.request('/runs?limit=0')
      const data = await res.json()
      expect(data.runs).toHaveLength(1)
    })

    it('GET /runs?root=true returns only root runs', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next' }))
      engine.register('step2', 'next', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const all = await app.request('/runs')
      const allData = await all.json()
      expect(allData.total).toBe(2)

      const roots = await app.request('/runs?root=true')
      const rootData = await roots.json()
      expect(rootData.total).toBe(1)
      expect(rootData.runs[0].parentRunId).toBeNull()
    })

    it('GET /runs/:id returns a single run', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      const runs = engine.emit('go', { x: 1 })
      await engine.drain()

      const res = await app.request(`/runs/${runs[0].id}`)
      const data = await res.json()
      expect(data.id).toBe(runs[0].id)
      expect(data.processName).toBe('proc')
      expect(data.status).toBe('completed')
    })

    it('GET /runs/:id exposes dead-letter status for exhausted retries', async () => {
      setup()
      engine.register(
        'proc',
        'go',
        async () => {
          throw new Error('fatal')
        },
        { retry: { maxRetries: 0, delay: 0 } },
      )
      const [run] = engine.emit('go', { x: 1 })
      await engine.drain()

      const res = await app.request(`/runs/${run.id}`)
      const data = await res.json()
      expect(data.state).toBe('errored')
      expect(data.status).toBe('dead-letter')
    })

    it('GET /runs/:id returns 404 for unknown id', async () => {
      setup()
      const res = await app.request('/runs/nonexistent')
      expect(res.status).toBe(404)
    })

    it('GET /runs/:id/chain returns the full chain', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle' }))
      engine.register('step2', 'middle', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const root = engine.getCompleted().find((r) => r.parentRunId === null)!
      const res = await app.request(`/runs/${root.id}/chain`)
      const data = await res.json()
      expect(data.runs.length).toBeGreaterThanOrEqual(2)
      expect(data.runs.every((run: any) => typeof run.status === 'string')).toBe(true)
    })

    it('GET /runs/:id/overlay resolves root chain and selected step in one payload', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle' }))
      engine.register('step2', 'middle', async (ctx) => {
        await ctx.effect('overlay-effect', async () => 'done')
        return { success: true, triggerEvent: 'end' }
      })
      engine.register('step3', 'end', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const root = engine.getCompleted().find((r) => r.parentRunId === null)!
      const chain = engine.getChain(root.id)
      const middle = chain.find((r) => r.processName === 'step2')!
      const end = chain.find((r) => r.processName === 'step3')!

      const res = await app.request(`/runs/${end.id}/overlay?selectedId=${middle.id}`)
      const data = await res.json()

      expect(data.rootRunId).toBe(root.id)
      expect(data.run.id).toBe(end.id)
      expect(data.selectedRun.id).toBe(middle.id)
      expect(data.selectedStepIdx).toBeGreaterThanOrEqual(0)
      expect(data.chain).toHaveLength(3)
      expect(data.effects).toHaveLength(1)
      expect(data.effects[0].effectKey).toBe('overlay-effect')
    })

    it('GET /runs/:id/trace returns trace spans', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle', deferred: true }))
      engine.emit('start', {})
      await engine.drain()

      const root = engine.getCompleted().find((r) => r.parentRunId === null)!
      const res = await app.request(`/runs/${root.id}/trace`)
      const data = await res.json()
      expect(data.correlationId).toBeDefined()
      expect(data.spans.length).toBeGreaterThanOrEqual(1)
      expect(data.durationMs).toBeGreaterThanOrEqual(0)
      expect(data.spans[0].state).toBe('completed')
      expect(data.spans[0].status).toBe('deferred')
    })

    it('GET /runs/:id/trace includes deferred resume gaps', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle', deferred: true }))
      engine.register('step2', 'middle', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const root = engine.getCompleted().find((r) => r.parentRunId === null)!
      await new Promise((resolve) => setTimeout(resolve, 75))
      const resumed = engine.resume(root.id)
      await engine.drain()

      const res = await app.request(`/runs/${root.id}/trace`)
      const data = await res.json()
      expect(data.spans).toHaveLength(2)
      expect(data.gaps).toHaveLength(1)
      expect(data.gaps[0].type).toBe('deferred')
      expect(data.gaps[0].parentRunId).toBe(root.id)
      expect(data.gaps[0].childRunIds).toContain(resumed[0].id)
      expect(data.gaps[0].durationMs).toBeGreaterThanOrEqual(50)
      expect(data.pausedDurationMs).toBe(data.gaps[0].durationMs)
      expect(data.executionDurationMs).toBeGreaterThanOrEqual(0)
      expect(data.durationMs).toBeGreaterThan(data.executionDurationMs)
    })

    it('GET /runs/:id/effects returns effect records', async () => {
      setup()
      engine.register('with-effect', 'go', async (ctx) => {
        await ctx.effect('my-key', async () => 'hello')
        return { success: true }
      })
      const runs = engine.emit('go', {})
      await engine.drain()

      const res = await app.request(`/runs/${runs[0].id}/effects`)
      const data = await res.json()
      expect(data.effects).toHaveLength(1)
      expect(data.effects[0].effectKey).toBe('my-key')
      expect(data.effects[0].state).toBe('completed')
    })

    it('POST /emit creates runs', async () => {
      setup()
      engine.register('proc', 'test-event', async () => ({ success: true }))

      const res = await app.request('/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'test-event', payload: { a: 1 } }),
      })
      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.created).toBe(1)
    })

    it('POST /emit returns 400 for missing event', async () => {
      setup()
      const res = await app.request('/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      })
      expect(res.status).toBe(400)
    })

    it('POST /emit returns 400 for malformed JSON', async () => {
      setup()
      const res = await app.request('/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      })
      expect(res.status).toBe(400)
    })

    it('POST /runs/:id/retry transitions errored run to idle', async () => {
      setup()
      engine.register('fail-proc', 'go', async () => ({ success: false, error: 'boom' }))
      engine.emit('go', {})
      await engine.drain()

      const errored = engine.getErrored()
      expect(errored).toHaveLength(1)

      const res = await app.request(`/runs/${errored[0].id}/retry`, { method: 'POST' })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.state).toBe('idle')
    })

    it('POST /runs/:id/retry returns 422 for non-errored run', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      const runs = engine.emit('go', {})
      await engine.drain()

      const res = await app.request(`/runs/${runs[0].id}/retry`, { method: 'POST' })
      expect(res.status).toBe(422)
    })

    it('POST /runs/:id/requeue returns idle state', async () => {
      setup()
      engine.register(
        'fail-proc',
        'go',
        async () => {
          throw new Error('boom')
        },
        { retry: { maxRetries: 0, delay: 0 } },
      )
      engine.emit('go', {})
      await engine.drain()

      const errored = engine.getErrored()
      const res = await app.request(`/runs/${errored[0].id}/requeue`, { method: 'POST' })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.state).toBe('idle')
    })

    it('POST /runs/:id/resume resumes a deferred run', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next', deferred: true }))
      engine.register('step2', 'next', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
      const res = await app.request(`/runs/${deferred.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.resumed).toBe(true)
      expect(data.runs.length).toBeGreaterThanOrEqual(1)
    })

    it('POST /runs/:id/resume returns 400 for malformed JSON', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next', deferred: true }))
      engine.emit('start', {})
      await engine.drain()

      const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
      const res = await app.request(`/runs/${deferred.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      })
      expect(res.status).toBe(400)
    })

    it('POST /runs/:id/resume works without body', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'next', deferred: true }))
      engine.register('step2', 'next', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const deferred = engine.getCompleted().find((r) => r.result?.deferred)!
      const res = await app.request(`/runs/${deferred.id}/resume`, { method: 'POST' })
      expect(res.ok).toBe(true)
    })

    it('POST /runs/:id/resume returns 422 for non-deferred run', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true }))
      const runs = engine.emit('go', {})
      await engine.drain()

      const res = await app.request(`/runs/${runs[0].id}/resume`, { method: 'POST' })
      expect(res.status).toBe(422)
    })

    it('GET /graph returns event graph', async () => {
      setup()
      engine.register('proc', 'go', async () => ({ success: true, triggerEvent: 'done' }))
      const res = await app.request('/graph')
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.nodes).toBeDefined()
    })
  })
}

routeTests('memory', {})
routeTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })

// ── Server lifecycle tests (store-independent) ──

describe('server lifecycle', () => {
  let engine: Engine

  afterEach(async () => {
    await engine?.stop()
  })

  it('starts on a random port and serves /health', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('greet', 'hello', async () => ({ success: true }))

    const server = await engine.getServer()!
    expect(server.address.port).toBeGreaterThan(0)

    const res = await fetch(`http://${server.address.host}:${server.address.port}/health`)
    expect(res.ok).toBe(true)
  })

  it('serves dashboard HTML at root', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!

    const res = await fetch(`http://${server.address.host}:${server.address.port}/`)
    expect(res.ok).toBe(true)
    const html = await res.text()
    expect(html).toContain('yella')
  })

  it('getServer() returns null without server config', () => {
    engine = createEngine()
    expect(engine.getServer()).toBeNull()
  })

  it('engine.stop() also stops the server', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!
    const { host, port } = server.address
    await engine.stop()

    await expect(fetch(`http://${host}:${port}/health`)).rejects.toThrow()
  })

  it('server.stop() stops only the server, engine continues', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('proc', 'go', async () => ({ success: true }))
    const server = await engine.getServer()!
    await server.stop()

    const runs = engine.emit('go', { x: 1 })
    expect(runs).toHaveLength(1)
    await engine.drain()
    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('exposes app for custom route extension', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!

    server.app.get('/custom', (c) => c.json({ custom: true }))

    const res = await fetch(`http://${server.address.host}:${server.address.port}/custom`)
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.custom).toBe(true)
  })
})
