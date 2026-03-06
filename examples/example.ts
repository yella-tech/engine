import fs from 'node:fs'
import { createEngine } from '../src/index.js'

// Clean up any previous run
const dbPath = 'runs.db'
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)

const engine = createEngine({
  store: { type: 'sqlite', path: dbPath },
  concurrency: 10,
  server: { port: 3400 },
})

// Helper: random delay between min and max ms
const delay = (min: number, max: number) =>
  new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))

// ─── Order Processing Pipeline ───────────────────────────────
// order:placed → validate → enrich → charge → fulfill → notify

engine.process({
  name: 'validate-order',
  on: 'order:placed',
  run: async (ctx) => {
    await delay(80, 200)
    ctx.setContext('validatedAt', Date.now())
    return ctx.ok({ valid: true }, { emit: 'order:validated' })
  },
})

// Fan-out: two processes listen to order:validated (parallel)
engine.process({
  name: 'enrich-order',
  on: 'order:validated',
  run: async (ctx) => {
    await delay(150, 400)
    ctx.setContext('customerTier', 'premium')
    return ctx.ok({ enriched: true }, { emit: 'order:enriched' })
  },
})

engine.process({
  name: 'fraud-check',
  on: 'order:validated',
  run: async (ctx) => {
    await delay(200, 500)
    return ctx.ok({ fraudScore: 0.02, passed: true })
  },
})

engine.process({
  name: 'charge-payment',
  on: 'order:enriched',
  run: async (ctx) => {
    await delay(200, 600)
    return ctx.ok({ charged: true, amount: (ctx.payload as any).total ?? 99.99 }, { emit: 'order:charged' })
  },
})

engine.process({
  name: 'fulfill-order',
  on: 'order:charged',
  run: async (ctx) => {
    await delay(100, 300)
    return ctx.ok({ shipped: true }, { emit: 'order:fulfilled' })
  },
})

// Fan-out: two processes listen to order:fulfilled
engine.process({
  name: 'send-confirmation',
  on: 'order:fulfilled',
  run: async (ctx) => {
    await delay(50, 150)
    return ctx.ok({ emailed: (ctx.payload as any).customer ?? 'customer@example.com' })
  },
})

engine.process({
  name: 'update-inventory',
  on: 'order:fulfilled',
  run: async (ctx) => {
    await delay(100, 250)
    return ctx.ok({ inventory: 'decremented' })
  },
})

engine.process({
  name: 'generate-invoice',
  on: 'order:fulfilled',
  run: async (ctx) => {
    await delay(150, 350)
    return ctx.ok({ invoiceId: 'INV-' + Date.now() })
  },
})

// ─── Background Analytics ────────────────────────────────────
// Separate chain: runs independently, takes longer

engine.process({
  name: 'compute-analytics',
  on: 'analytics:trigger',
  run: async (ctx) => {
    await delay(300, 800)
    return ctx.ok({ metrics: { orders: 42, revenue: 4199.58 } }, { emit: 'analytics:computed' })
  },
})

engine.process({
  name: 'cache-dashboard',
  on: 'analytics:computed',
  run: async (ctx) => {
    await delay(100, 200)
    return ctx.ok({ cached: true })
  },
})

// ─── Error case ──────────────────────────────────────────────

engine.process({
  name: 'flaky-webhook',
  on: 'webhook:incoming',
  run: async () => {
    await delay(50, 150)
    if (Math.random() > 0.5) throw new Error('Connection refused')
    return { success: true }
  },
})

// ─── Run it ──────────────────────────────────────────────────

async function main() {
  const server = await engine.getServer()!
  console.log(`Dashboard: http://${server.address.host}:${server.address.port}\n`)

  // Fire off an order chain
  console.log('--- Order pipeline ---')
  engine.emit('order:placed', {
    customer: 'alice@example.com',
    items: ['widget-a', 'widget-b'],
    total: 149.99,
  })

  // Fire off analytics
  console.log('--- Analytics ---')
  engine.emit('analytics:trigger', { date: new Date().toISOString() })

  // Fire off some flaky webhooks
  console.log('--- Webhooks (some will fail) ---')
  for (let i = 0; i < 3; i++) {
    engine.emit('webhook:incoming', { attempt: i })
  }

  // Wait for everything to process
  await engine.drain()

  const completed = engine.getCompleted()
  const errored = engine.getErrored()
  console.log(`\nCompleted: ${completed.length}, Errored: ${errored.length}`)
  console.log(`Dashboard running at http://${server.address.host}:${server.address.port}`)
  console.log('Press Ctrl+C to stop')
}

main()
