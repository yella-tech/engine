import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'
import type { Engine } from './types.js'

describe('dev server', () => {
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
    const data = await res.json()
    expect(data.status).toBe('ok')
    expect(data.queue).toBeDefined()
    expect(data.processes).toHaveLength(1)
    expect(data.processes[0].name).toBe('greet')
  })

  it('serves dashboard HTML at root', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!

    const res = await fetch(`http://${server.address.host}:${server.address.port}/`)
    expect(res.ok).toBe(true)
    const html = await res.text()
    expect(html).toContain('yella')
  })

  it('GET /runs returns runs by state', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', { x: 1 })
    await engine.drain()

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs?state=completed`)
    const data = await res.json()
    expect(data.runs).toHaveLength(1)
    expect(data.runs[0].state).toBe('completed')
  })

  it('GET /runs/:id returns a single run', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('proc', 'go', async () => ({ success: true }))
    const runs = engine.emit('go', { x: 1 })
    await engine.drain()

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${runs[0].id}`)
    const data = await res.json()
    expect(data.id).toBe(runs[0].id)
    expect(data.processName).toBe('proc')
  })

  it('GET /runs/:id returns 404 for unknown id', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('GET /runs/:id/chain returns the chain', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle' }))
    engine.register('step2', 'middle', async () => ({ success: true }))
    engine.emit('start', {})
    await engine.drain()

    const completed = engine.getCompleted()
    const root = completed.find((r) => r.parentRunId === null)!

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${root.id}/chain`)
    const data = await res.json()
    expect(data.runs.length).toBeGreaterThanOrEqual(2)
  })

  it('GET /runs/:id/trace returns trace data', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('step1', 'start', async () => ({ success: true, triggerEvent: 'middle' }))
    engine.register('step2', 'middle', async () => ({ success: true }))
    engine.emit('start', {})
    await engine.drain()

    const completed = engine.getCompleted()
    const root = completed.find((r) => r.parentRunId === null)!

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${root.id}/trace`)
    const data = await res.json()
    expect(data.correlationId).toBeDefined()
    expect(data.spans.length).toBeGreaterThanOrEqual(2)
    expect(data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('POST /emit creates runs', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('proc', 'test-event', async () => ({ success: true }))

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'test-event', payload: { a: 1 } }),
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.created).toBe(1)
    expect(data.runs).toHaveLength(1)
  })

  it('POST /emit returns 400 for missing event', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /emit returns 400 for malformed JSON', async () => {
    engine = createEngine({ server: { port: 0 } })
    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('Invalid JSON')
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

    // Engine still works
    const runs = engine.emit('go', { x: 1 })
    expect(runs).toHaveLength(1)
    await engine.drain()
    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('GET /runs/:id/effects returns effect records', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('with-effect', 'go', async (ctx) => {
      await ctx.effect('my-key', async () => 'hello')
      return { success: true }
    })
    const runs = engine.emit('go', {})
    await engine.drain()

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${runs[0].id}/effects`)
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.effects).toHaveLength(1)
    expect(data.effects[0].effectKey).toBe('my-key')
    expect(data.effects[0].state).toBe('completed')
    expect(data.effects[0].output).toBe('hello')
  })

  it('POST /runs/:id/retry transitions errored run to idle', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('fail-proc', 'go', async () => ({ success: false, error: 'boom' }))
    engine.emit('go', {})
    await engine.drain()

    const errored = engine.getErrored()
    expect(errored).toHaveLength(1)

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${errored[0].id}/retry`, { method: 'POST' })
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.state).toBe('idle')
  })

  it('POST /runs/:id/requeue returns idle state', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('fail-proc', 'go', async () => ({ success: false, error: 'boom' }))
    engine.emit('go', {})
    await engine.drain()

    const errored = engine.getErrored()
    expect(errored).toHaveLength(1)

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${errored[0].id}/requeue`, { method: 'POST' })
    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.state).toBe('idle')
  })

  it('POST /runs/:id/retry returns 422 for non-errored run', async () => {
    engine = createEngine({ server: { port: 0 } })
    engine.register('proc', 'go', async () => ({ success: true }))
    const runs = engine.emit('go', {})
    await engine.drain()

    const server = await engine.getServer()!
    const res = await fetch(`http://${server.address.host}:${server.address.port}/runs/${runs[0].id}/retry`, { method: 'POST' })
    expect(res.status).toBe(422)
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
