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
    })

    it('GET /runs/:id/trace returns trace spans', async () => {
      setup()
      engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle' }))
      engine.register('step2', 'middle', async () => ({ success: true }))
      engine.emit('start', {})
      await engine.drain()

      const root = engine.getCompleted().find((r) => r.parentRunId === null)!
      const res = await app.request(`/runs/${root.id}/trace`)
      const data = await res.json()
      expect(data.correlationId).toBeDefined()
      expect(data.spans.length).toBeGreaterThanOrEqual(2)
      expect(data.durationMs).toBeGreaterThanOrEqual(0)
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
      engine.register('fail-proc', 'go', async () => ({ success: false, error: 'boom' }))
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
