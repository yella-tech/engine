import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Engine, DevServer, DevServerOptions } from '../types.js'
import { registerRoutes } from './routes.js'

export function createDevServer(engine: Engine, opts?: DevServerOptions): Promise<DevServer> {
  const host = opts?.host ?? '127.0.0.1'
  const port = opts?.port ?? 3000

  const app = new Hono()
  app.use('*', cors())

  registerRoutes(app, engine)

  // Serve dashboard static files
  const publicDir = path.join(__dirname, 'public')
  let html: string
  try {
    html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
  } catch {
    html = '<html><body><p>Dashboard HTML not found. Run <code>npm run build</code> to include it.</p></body></html>'
  }
  app.get('/', (c) => c.html(html))

  let css: string
  try {
    css = fs.readFileSync(path.join(publicDir, 'brutalist.css'), 'utf-8')
  } catch {
    css = ''
  }
  app.get('/brutalist.css', (c) => {
    c.header('Content-Type', 'text/css')
    c.header('Cache-Control', 'public, max-age=3600')
    return c.body(css)
  })

  return new Promise<DevServer>((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolve({
        address: { host: info.address as string, port: info.port },
        app,
        stop: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
  })
}
