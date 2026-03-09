import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { DevServer } from '../types.js'
import type { RoutableEngine } from './routes.js'
import { registerRoutes } from './routes.js'

function readFileOr(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return fallback
  }
}

const fallbackHtml = '<html><body><p>Dashboard not found. Run <code>npm run build</code> to build UI.</p></body></html>'

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

export function serveDashboard(app: Hono): void {
  // When running from dist/, ../ui → dist/ui/ (correct).
  // When running from source via tsx, ../ui → src/ui/ (dev files, no built assets).
  // Detect by checking for app.js; fall back to the dist/ui/ path from the repo root.
  const candidateUiDir = path.join(__dirname, '../ui')
  const uiDir = fs.existsSync(path.join(candidateUiDir, 'app.js')) ? candidateUiDir : path.join(__dirname, '../../dist/ui')
  const publicDir = path.join(__dirname, 'public')

  // Try built Vite output first, fall back to legacy public dir
  const indexHtml = readFileOr(path.join(uiDir, 'index.html'), readFileOr(path.join(publicDir, 'index.html'), fallbackHtml))

  app.get('/', (c) => c.html(indexHtml))

  // Serve all built UI assets from dist/ui/
  const uiFiles = safeReadDir(uiDir)
  for (const file of uiFiles) {
    if (file === 'index.html') continue
    const ext = path.extname(file)
    const content = readFileOr(path.join(uiDir, file), '')
    if (content) {
      app.get('/' + file, (c) => {
        c.header('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
        c.header('Cache-Control', 'public, max-age=3600')
        return c.body(content)
      })
    }
  }

  // Serve legacy brutalist.css for backward compatibility
  const legacyCss = readFileOr(path.join(publicDir, 'brutalist.css'), '')
  if (legacyCss && !uiFiles.includes('brutalist.css')) {
    app.get('/brutalist.css', (c) => {
      c.header('Content-Type', 'text/css')
      c.header('Cache-Control', 'public, max-age=3600')
      return c.body(legacyCss)
    })
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

export function createDevServer(engine: RoutableEngine): DevServer {
  const app = new Hono()
  app.use('*', cors())

  registerRoutes(app, engine)
  serveDashboard(app)

  let httpServer: ReturnType<typeof serve> | null = null
  const address = { host: '', port: 0 }

  return {
    app,
    address,
    async serve(opts?: { host?: string; port?: number }) {
      const host = opts?.host ?? '127.0.0.1'
      const port = opts?.port ?? 3000
      return new Promise<{ host: string; port: number }>((resolve) => {
        httpServer = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
          const addr = { host: info.address as string, port: info.port }
          Object.assign(address, addr)
          resolve(addr)
        })
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
