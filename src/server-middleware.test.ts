import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'
import { createDevServer } from './server/index.js'
import type { Engine } from './types.js'

describe('server middleware option', () => {
  let engine: Engine
  afterEach(async () => {
    await engine?.stop()
  })

  it('createDevServer runs supplied middleware before the engine routes', async () => {
    engine = createEngine({ store: { type: 'memory' } })
    const server = createDevServer(engine, {
      dashboardFallback: false,
      middleware: [async (c, next) => (c.req.header('authorization') === 'Bearer ok' ? next() : c.text('unauthorized', 401))],
    })
    expect((await server.app.request('/health')).status).toBe(401)
    expect((await server.app.request('/health', { headers: { authorization: 'Bearer ok' } })).status).toBe(200)
  })

  it('engine server option passes middleware through', async () => {
    engine = createEngine({
      store: { type: 'memory' },
      server: { port: 0, middleware: [async (c, next) => (c.req.header('authorization') === 'Bearer ok' ? next() : c.text('unauthorized', 401))] },
    })
    const server = await engine.getServer()!
    expect((await server.app.request('/health')).status).toBe(401)
    expect((await server.app.request('/health', { headers: { authorization: 'Bearer ok' } })).status).toBe(200)
  })
})
