import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import type { DevServer } from '../types.js'
import type { RoutableEngine } from './contract.js'
import { createEngineApi } from './routes.js'

function readFileOr(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return fallback
  }
}

const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>yella // dashboard unavailable</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="hero">
        <div class="badge">YELLA</div>
        <h1>Dashboard bundle not found</h1>
        <p>Run <code>npm run build</code> to generate the dashboard assets.</p>
      </header>
    </div>
  </body>
</html>`

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

type DashboardAsset = {
  content: string
  contentType: string
}

/** Resolve the built engine dashboard directory, falling back to `dist/ui` when running from source. */
export function resolveEngineUiDir(): string {
  const candidate = path.join(__dirname, '../ui')
  return fs.existsSync(path.join(candidate, 'app.js')) ? candidate : path.join(__dirname, '../../dist/ui')
}

function buildDashboardBundle(uiDir: string): { indexHtml: string; assets: Map<string, DashboardAsset> } {
  const publicDir = path.join(__dirname, 'public')
  const indexHtml = readFileOr(path.join(uiDir, 'index.html'), fallbackHtml)
  const assets = new Map<string, DashboardAsset>()

  const fallbackCssPath = path.join(publicDir, 'brutalist.css')
  const fallbackCss = readFileOr(fallbackCssPath, '')
  if (fallbackCss) {
    assets.set('/style.css', {
      content: fallbackCss,
      contentType: 'text/css',
    })
  }

  const uiFiles = safeReadDir(uiDir)
  for (const file of uiFiles) {
    if (file === 'index.html') continue
    const ext = path.extname(file)
    const content = readFileOr(path.join(uiDir, file), '')
    if (content) {
      assets.set('/' + file, {
        content,
        contentType: MIME_TYPES[ext] || 'application/octet-stream',
      })
    }
  }

  return { indexHtml, assets }
}

function respondWithAsset(c: Context, asset: DashboardAsset) {
  c.header('Content-Type', asset.contentType)
  c.header('Cache-Control', 'public, max-age=3600')
  return c.body(asset.content)
}

function installDashboardFallback(app: Hono, uiDir: string): void {
  const { indexHtml, assets } = buildDashboardBundle(uiDir)

  app.notFound((c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('404 Not Found', 404)
    }
    if (c.req.path === '/') return c.html(indexHtml)
    const asset = assets.get(c.req.path)
    if (asset) return respondWithAsset(c, asset)
    return c.text('404 Not Found', 404)
  })
}

/**
 * Mount the engine dashboard UI onto an existing Hono app.
 *
 * This serves `index.html` at `/` and any built dashboard assets from `uiDir`.
 * It does not register API routes; pair it with {@link createDevServer} or
 * {@link registerRoutes} when building a custom server.
 */
export function serveDashboard(app: Hono, uiDir: string): void {
  const { indexHtml, assets } = buildDashboardBundle(uiDir)

  app.get('/', (c) => c.html(indexHtml))

  for (const [route, asset] of assets) {
    app.get(route, (c) => respondWithAsset(c, asset))
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Create a development server exposing the engine HTTP API and, by default,
 * the dashboard UI fallback.
 *
 * The returned server is not listening until {@link DevServer.serve} is called.
 * Pass `dashboardFallback: false` when composing your own dashboard mounting.
 */
export function createDevServer(engine: RoutableEngine, opts?: { dashboardFallback?: boolean; uiDir?: string }): DevServer {
  const app = new Hono()
  createEngineApi(engine, app)
  if (opts?.dashboardFallback !== false) {
    installDashboardFallback(app, opts?.uiDir ?? resolveEngineUiDir())
  }

  let httpServer: ReturnType<typeof serve> | null = null
  const address = { host: '', port: 0 }

  return {
    app,
    address,
    async serve(opts?: { host?: string; port?: number }) {
      const host = opts?.host ?? '127.0.0.1'
      const port = opts?.port ?? 3000
      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        let server: ReturnType<typeof serve>
        const onError = (err: Error) => {
          if (httpServer === server) httpServer = null
          reject(err)
        }
        try {
          server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
            server.off('error', onError)
            const addr = { host: info.address as string, port: info.port }
            Object.assign(address, addr)
            resolve(addr)
          })
        } catch (err) {
          reject(err)
          return
        }
        httpServer = server
        server.once('error', onError)
      })
    },
    async stop() {
      if (!httpServer) return
      return new Promise<void>((res, rej) => {
        httpServer!.close((err) => (err ? rej(err) : res()))
        httpServer = null
      })
    },
  }
}
