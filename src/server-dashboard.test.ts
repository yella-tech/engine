import crypto from 'node:crypto'
import path from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createEngine } from './index.js'
import { createDevServer, serveDashboard } from './server/index.js'
import type { Engine } from './types.js'

describe('dashboard serving', () => {
  let engine: Engine

  afterEach(async () => {
    await engine?.stop()
  })

  it('createDevServer serves the engine dashboard at root without explicit mounting', async () => {
    engine = createEngine()
    const server = createDevServer(engine)

    const res = await server.app.request('http://local/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('yella')

    const css = await server.app.request('http://local/style.css')
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--black')
  })

  it('serveDashboard falls back to the minimal branded shell when the UI dir is missing', async () => {
    const app = new Hono()
    const missingUiDir = path.join(process.cwd(), `missing-ui-${crypto.randomUUID()}`)

    serveDashboard(app, missingUiDir)

    const res = await app.request('http://local/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('YELLA')
    expect(html).toContain('Dashboard bundle not found')

    const css = await app.request('http://local/style.css')
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('--black')
  })
})
