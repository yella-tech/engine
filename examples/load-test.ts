import fs from 'node:fs'
import crypto from 'node:crypto'
import { createEngine } from '../src/index.js'
import type { EngineObservabilityBucket } from '../src/types.js'

// ─── CLI ─────────────────────────────────────────────────────

const PROFILE = (process.argv[2] ?? 'synthetic') as 'synthetic' | 'realistic'
if (PROFILE !== 'synthetic' && PROFILE !== 'realistic') {
  console.error('Usage: load-test [synthetic|realistic]')
  process.exit(1)
}

// ─── Config ──────────────────────────────────────────────────

const DB_PATH = '_db/load-test.db'
const DASHBOARD_PORT = 3400
const SAMPLE_INTERVAL_MS = 2_000
const DRAIN_TIMEOUT_MS = 600_000

const PROFILES = {
  synthetic: {
    label: 'Synthetic (max throughput)',
    concurrency: 20,
    phases: [
      { label: 'warm-up', eventsPerSec: 5, durationSec: 30 },
      { label: '10x', eventsPerSec: 50, durationSec: 60 },
      { label: '20x', eventsPerSec: 100, durationSec: 60 },
      { label: '50x', eventsPerSec: 250, durationSec: 60 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 30 },
    ],
    // Fast in-process delays, no failures
    handler: {
      validateMs: [5, 30],
      processMs: [5, 40],
      notifyMs: [5, 20],
      archiveMs: [5, 25],
      deepStepMs: [5, 50],
      effectMs: [2, 10],
      finishMs: [5, 15],
      // No simulated failures or slow outliers
      failRate: 0,
      slowOutlierRate: 0,
      slowOutlierMs: [0, 0],
    },
  },
  realistic: {
    label: 'Realistic (API call simulation)',
    concurrency: 1000,
    phases: [
      { label: 'warm-up', eventsPerSec: 50, durationSec: 30 },
      { label: 'steady', eventsPerSec: 200, durationSec: 60 },
      { label: 'peak', eventsPerSec: 600, durationSec: 60 },
      { label: 'surge', eventsPerSec: 1200, durationSec: 60 },
      { label: 'spike', eventsPerSec: 2000, durationSec: 30 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    // Simulating real API calls: validation is fast, external calls are 200-800ms
    handler: {
      validateMs: [20, 80],       // schema validation, quick DB lookup
      processMs: [200, 600],      // main API call (Stripe, CRM, etc.)
      notifyMs: [100, 400],       // email/webhook dispatch
      archiveMs: [50, 200],       // storage write (S3, DB)
      deepStepMs: [150, 500],     // multi-step pipeline stage
      effectMs: [100, 300],       // durable side effect (API call)
      finishMs: [30, 100],        // final cleanup
      // 3% of handlers fail (API errors, timeouts, rate limits)
      failRate: 0.03,
      // 5% of handlers are slow outliers (cold starts, retries, rate limiting)
      slowOutlierRate: 0.05,
      slowOutlierMs: [2000, 5000],
    },
  },
} as const

const config = PROFILES[PROFILE]

// ─── Helpers ─────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
function randomPayload() {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    source: ['webhook', 'api', 'cron', 'manual'][Math.floor(Math.random() * 4)],
    user: {
      id: `usr_${crypto.randomBytes(8).toString('hex')}`,
      email: `user${Math.floor(Math.random() * 10000)}@example.com`,
      name: `User ${Math.floor(Math.random() * 10000)}`,
      plan: ['free', 'pro', 'enterprise'][Math.floor(Math.random() * 3)],
      metadata: {
        createdAt: new Date(Date.now() - Math.random() * 365 * 86400000).toISOString(),
        lastLogin: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
        loginCount: Math.floor(Math.random() * 500),
        preferences: { theme: 'dark', locale: 'en-US', notifications: true },
      },
    },
    data: {
      action: ['created', 'updated', 'deleted', 'processed'][Math.floor(Math.random() * 4)],
      resource: ['order', 'invoice', 'subscription', 'ticket'][Math.floor(Math.random() * 4)],
      resourceId: `res_${crypto.randomBytes(12).toString('hex')}`,
      amount: Math.round(Math.random() * 10000) / 100,
      currency: 'USD',
      tags: Array.from({ length: 2 + Math.floor(Math.random() * 4) }, () =>
        ['urgent', 'vip', 'follow-up', 'automated', 'review', 'escalated'][Math.floor(Math.random() * 6)],
      ),
      notes: crypto.randomBytes(64 + Math.floor(Math.random() * 128)).toString('base64'),
    },
  }
}
const fmt = (n: number) => n.toLocaleString()
const fmtMs = (n: number | null) => (n === null ? '-' : `${Math.round(n)}ms`)
const fmtMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`

/** Simulate a handler delay with optional slow outliers and failures. */
function handlerDelay(range: readonly [number, number]): Promise<void> {
  const h = config.handler
  // Slow outlier?
  if (h.slowOutlierRate > 0 && Math.random() < h.slowOutlierRate) {
    const ms = h.slowOutlierMs[0] + Math.random() * (h.slowOutlierMs[1] - h.slowOutlierMs[0])
    return wait(ms)
  }
  const ms = range[0] + Math.random() * (range[1] - range[0])
  return wait(ms)
}

function maybeThrow() {
  if (config.handler.failRate > 0 && Math.random() < config.handler.failRate) {
    const errors = [
      'ECONNRESET: upstream API connection reset',
      'HTTP 429: rate limit exceeded',
      'HTTP 503: service temporarily unavailable',
      'ETIMEDOUT: API call timed out after 10s',
      'HTTP 500: internal server error from downstream',
    ]
    throw new Error(errors[Math.floor(Math.random() * errors.length)])
  }
}

// ─── Register handlers ──────────────────────────────────────

function registerHandlers(engine: ReturnType<typeof createEngine>) {
  const h = config.handler

  // Shallow chain: load:start -> load:validated -> load:done (x2 fan-out)
  // = 4 runs per seed event

  engine.process({
    name: 'load-validate',
    on: 'load:start',
    run: async (ctx) => {
      await handlerDelay(h.validateMs)
      maybeThrow()
      ctx.setContext('validatedAt', Date.now())
      return ctx.ok({ valid: true }, { emit: 'load:validated' })
    },
  })

  engine.process({
    name: 'load-process',
    on: 'load:validated',
    run: async (ctx) => {
      await handlerDelay(h.processMs)
      maybeThrow()
      ctx.setContext('processedBy', 'worker-' + Math.floor(Math.random() * 10))
      return ctx.ok({ processed: true }, { emit: 'load:done' })
    },
  })

  engine.process({
    name: 'load-notify',
    on: 'load:done',
    run: async (ctx) => {
      await handlerDelay(h.notifyMs)
      maybeThrow()
      return ctx.ok({ notified: true })
    },
  })

  engine.process({
    name: 'load-archive',
    on: 'load:done',
    run: async (ctx) => {
      await handlerDelay(h.archiveMs)
      maybeThrow()
      return ctx.ok({ archived: true })
    },
  })

  // Deep chain: deep:start -> 6 steps -> deep:done = 7 runs per seed
  const deepSteps = ['deep:start', 'deep:s1', 'deep:s2', 'deep:s3', 'deep:s4', 'deep:s5']

  for (let i = 0; i < deepSteps.length; i++) {
    const from = deepSteps[i]
    const to = i < deepSteps.length - 1 ? deepSteps[i + 1] : 'deep:done'
    const useEffect = i === 1 || i === 4

    engine.process({
      name: `deep-step-${i}`,
      on: from,
      run: async (ctx) => {
        await handlerDelay(h.deepStepMs)
        maybeThrow()
        ctx.setContext(`step${i}`, Date.now())
        if (useEffect) {
          await ctx.effect({
            key: `compute-${i}`,
            run: async () => {
              await handlerDelay(h.effectMs)
              return { hash: crypto.randomBytes(8).toString('hex') }
            },
          })
        }
        return ctx.ok({ step: i, ok: true }, { emit: to })
      },
    })
  }

  engine.process({
    name: 'deep-finish',
    on: 'deep:done',
    run: async (ctx) => {
      await handlerDelay(h.finishMs)
      maybeThrow()
      return ctx.ok({ depth: 7, completed: true })
    },
  })
}

// ─── Sampler ─────────────────────────────────────────────────

type Sample = {
  elapsedSec: number
  phase: string
  emitRate: number
  idle: number
  running: number
  completed: number
  errored: number
  rssBytes: number
  heapUsedBytes: number
  p50Ms: number | null
  p95Ms: number | null
  avgMs: number | null
  maxMs: number | null
  runsPerSec: number
  sqliteErrors: number
  walSizeBytes: number
}

// ─── Report ──────────────────────────────────────────────────

function printReport(engine: ReturnType<typeof createEngine>, samples: Sample[], startTime: number, totalEmitted: number, sqliteErrors: number) {
  const endTime = Date.now()
  const totalElapsed = (endTime - startTime) / 1000
  const metrics = engine.getMetrics()
  const obs = engine.getObservability({ from: startTime, to: endTime, bucketMs: 10_000 })
  const dbStat = fs.statSync(DB_PATH)

  console.log()
  console.log('═'.repeat(80))
  console.log(`Post-Mortem Report  [${config.label}]`)
  console.log('═'.repeat(80))
  console.log()

  // Totals
  console.log('  Totals')
  console.log('  ──────')
  console.log(`    Duration:        ${Math.round(totalElapsed)}s`)
  console.log(`    Events emitted:  ${fmt(totalEmitted)}`)
  console.log(`    Runs completed:  ${fmt(metrics.queue.completed)}`)
  console.log(`    Runs errored:    ${fmt(metrics.queue.errored)}`)
  console.log(`    Retries:         ${fmt(metrics.totals.retries)}`)
  console.log(`    Dead letters:    ${fmt(metrics.totals.deadLetters)}`)
  console.log(`    SQLite errors:   ${sqliteErrors}`)
  console.log(`    Throughput:      ${Math.round((metrics.queue.completed + metrics.queue.errored) / totalElapsed)} runs/s avg`)
  console.log()

  // Duration stats
  const d = obs.summary.runs.duration
  console.log('  Run Duration')
  console.log('  ────────────')
  console.log(`    avg:  ${fmtMs(d.avgMs)}`)
  console.log(`    p50:  ${fmtMs(d.p50Ms)}`)
  console.log(`    p95:  ${fmtMs(d.p95Ms)}`)
  console.log(`    min:  ${fmtMs(d.minMs)}`)
  console.log(`    max:  ${fmtMs(d.maxMs)}`)
  console.log()

  // Histogram
  const h = d.histogram
  console.log('  Duration Histogram')
  console.log('  ──────────────────')
  const buckets = [
    ['≤10ms', h.le10ms],
    ['≤50ms', h.le50ms],
    ['≤100ms', h.le100ms],
    ['≤250ms', h.le250ms],
    ['≤500ms', h.le500ms],
    ['≤1s', h.le1000ms],
    ['≤2.5s', h.le2500ms],
    ['≤5s', h.le5000ms],
    ['≤10s', h.le10000ms],
    ['>10s', h.gt10000ms],
  ] as const
  const maxCount = Math.max(...buckets.map(([, c]) => c), 1)
  for (const [label, count] of buckets) {
    if (count === 0) continue
    const bar = '█'.repeat(Math.round((count / maxCount) * 40))
    console.log(`    ${label.padStart(7)}  ${String(count).padStart(8)}  ${bar}`)
  }
  console.log()

  // Memory
  const mem = process.memoryUsage()
  console.log('  Memory')
  console.log('  ──────')
  console.log(`    RSS:        ${fmtMB(mem.rss)}`)
  console.log(`    Heap used:  ${fmtMB(mem.heapUsed)}`)
  console.log(`    Heap total: ${fmtMB(mem.heapTotal)}`)
  console.log(`    DB file:    ${fmtMB(dbStat.size)}`)
  console.log()

  // Per-bucket p95 trend (10s buckets)
  if (obs.buckets.length > 0) {
    console.log('  P95 Trend (10s buckets)')
    console.log('  ───────────────────────')
    const significantBuckets = obs.buckets.filter((b: EngineObservabilityBucket) => b.runs.duration.count > 0)
    const maxP95 = Math.max(...significantBuckets.map((b: EngineObservabilityBucket) => b.runs.duration.p95Ms ?? 0), 1)
    for (const bucket of significantBuckets) {
      const t = Math.round((bucket.bucketStart - startTime) / 1000)
      const p95 = bucket.runs.duration.p95Ms
      const count = bucket.runs.duration.count
      const bar = p95 !== null ? '▓'.repeat(Math.round((p95 / maxP95) * 40)) : ''
      console.log(`    ${String(t).padStart(4)}s  ${fmtMs(p95).padStart(8)}  (${String(count).padStart(5)} runs)  ${bar}`)
    }
    console.log()
  }

  // Queue depth over time
  console.log('  Queue Depth Over Time')
  console.log('  ─────────────────────')
  const maxIdle = Math.max(...samples.map((s) => s.idle), 1)
  for (const s of samples) {
    const bar = s.idle > 0 ? '░'.repeat(Math.max(1, Math.round((s.idle / maxIdle) * 40))) : ''
    console.log(`    ${String(s.elapsedSec).padStart(4)}s  ${s.phase.padEnd(12)}  ${String(s.idle).padStart(6)} idle  ${bar}`)
  }
  console.log()

  // RSS over time
  console.log('  RSS Over Time')
  console.log('  ─────────────')
  const rssValues = samples.map((s) => s.rssBytes)
  const minRss = Math.min(...rssValues)
  const maxRss = Math.max(...rssValues)
  const rssRange = maxRss - minRss || 1
  for (const s of samples) {
    const bar = '▒'.repeat(Math.round(((s.rssBytes - minRss) / rssRange) * 40))
    console.log(`    ${String(s.elapsedSec).padStart(4)}s  ${fmtMB(s.rssBytes).padStart(6)}  ${bar}`)
  }
  console.log()

  // WAL size over time
  const walValues = samples.map((s) => s.walSizeBytes)
  const maxWal = Math.max(...walValues)
  if (maxWal > 0) {
    console.log('  WAL Size Over Time')
    console.log('  ──────────────────')
    for (const s of samples) {
      const bar = s.walSizeBytes > 0 ? '▓'.repeat(Math.max(1, Math.round((s.walSizeBytes / maxWal) * 40))) : ''
      console.log(`    ${String(s.elapsedSec).padStart(4)}s  ${fmtMB(s.walSizeBytes).padStart(6)}  ${bar}`)
    }
    console.log()
  }

  // Final state
  const finalIdle = engine.countByState('idle')
  const finalRunning = engine.countByState('running')
  console.log(`  Final queue: ${finalIdle} idle, ${finalRunning} running`)
  if (finalIdle > 0 || finalRunning > 0) {
    console.log(`  ⚠ ${finalIdle + finalRunning} runs did not complete within drain timeout`)
  }
  console.log()
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync('_db', { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }

  let sqliteErrors = 0

  const engine = createEngine({
    store: { type: 'sqlite', path: DB_PATH },
    concurrency: config.concurrency,
    maxChainDepth: 10,
    retry: PROFILE === 'realistic' ? { maxRetries: 2, delay: (attempt) => 500 * Math.pow(2, attempt) } : undefined,
    server: { port: DASHBOARD_PORT },
    onRunError: (_run, error) => {
      if (typeof error === 'string' && (error.includes('SQLITE_BUSY') || error.includes('SQLITE_LOCKED'))) {
        sqliteErrors++
      }
    },
    onInternalError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED')) {
        sqliteErrors++
      }
    },
  })

  registerHandlers(engine)

  const server = await engine.getServer()!
  console.log(`Dashboard: http://${server.address.host}:${server.address.port}`)

  const totalDuration = config.phases.reduce((sum, p) => sum + p.durationSec, 0)
  const totalEvents = config.phases.reduce((sum, p) => sum + p.eventsPerSec * p.durationSec, 0)

  console.log()
  console.log(`Yella Engine Load Test  [${config.label}]`)
  console.log('═'.repeat(80))
  console.log(`  Concurrency:   ${config.concurrency}`)
  console.log(`  Duration:      ${totalDuration}s across ${config.phases.length} phases`)
  console.log(`  Seed events:   ~${fmt(totalEvents)} (each spawns 4-7 runs)`)
  console.log(`  Expected runs: ~${fmt(totalEvents * 5)} (mixed shallow/deep)`)
  if (PROFILE === 'realistic') {
    console.log(`  Handler time:  ${config.handler.processMs[0]}-${config.handler.processMs[1]}ms (main), ${config.handler.validateMs[0]}-${config.handler.validateMs[1]}ms (validate)`)
    console.log(`  Failure rate:  ${config.handler.failRate * 100}%  |  Slow outliers: ${config.handler.slowOutlierRate * 100}% (${config.handler.slowOutlierMs[0]}-${config.handler.slowOutlierMs[1]}ms)`)
    console.log(`  Retry policy:  2 retries, exponential backoff (500ms, 1s, 2s)`)
  }
  console.log()
  console.log('  Phases:')
  for (const phase of config.phases) {
    console.log(`    ${phase.label.padEnd(12)} ${String(phase.eventsPerSec).padStart(4)} events/s × ${phase.durationSec}s`)
  }
  console.log('═'.repeat(80))
  console.log()

  // ── Live sampling ────────────────────────────────────────────

  const samples: Sample[] = []
  const startTime = Date.now()
  let lastCompleted = 0
  let lastErrored = 0
  let lastSampleTime = startTime

  function takeSample(phase: string, emitRate: number) {
    const now = Date.now()
    const elapsedSec = Math.round((now - startTime) / 1000)
    const mem = process.memoryUsage()
    const metrics = engine.getMetrics()
    const obs = engine.getObservability({ from: startTime, to: now })

    const dtSec = (now - lastSampleTime) / 1000
    const newDone = (metrics.queue.completed + metrics.queue.errored) - (lastCompleted + lastErrored)
    const runsPerSec = dtSec > 0 ? Math.round((newDone / dtSec) * 10) / 10 : 0

    let walSizeBytes = 0
    try {
      walSizeBytes = fs.statSync(DB_PATH + '-wal').size
    } catch {}

    const sample: Sample = {
      elapsedSec,
      phase,
      emitRate,
      idle: metrics.queue.idle,
      running: metrics.queue.running,
      completed: metrics.queue.completed,
      errored: metrics.queue.errored,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      p50Ms: obs.summary.runs.duration.p50Ms,
      p95Ms: obs.summary.runs.duration.p95Ms,
      avgMs: obs.summary.runs.duration.avgMs,
      maxMs: obs.summary.runs.duration.maxMs,
      runsPerSec,
      sqliteErrors,
      walSizeBytes,
    }

    samples.push(sample)
    lastCompleted = metrics.queue.completed
    lastErrored = metrics.queue.errored
    lastSampleTime = now

    const errStr = sample.errored > 0 ? `  err: ${fmt(sample.errored)}` : ''

    process.stdout.write(
      `  ${String(elapsedSec).padStart(4)}s ` +
        `│ ${phase.padEnd(12)} ` +
        `│ q: ${String(sample.idle).padStart(5)} idle ${String(sample.running).padStart(3)} run ` +
        `│ done: ${fmt(sample.completed).padStart(7)}${errStr} ` +
        `│ ${String(sample.runsPerSec).padStart(7)} run/s ` +
        `│ p95: ${fmtMs(sample.p95Ms).padStart(7)} ` +
        `│ rss: ${fmtMB(sample.rssBytes).padStart(5)} ` +
        `│ wal: ${fmtMB(sample.walSizeBytes).padStart(4)} ` +
        `│ sq: ${sample.sqliteErrors}` +
        '\n',
    )
  }

  // Header
  console.log(
    `  ${'t'.padStart(4)}s ` +
      `│ ${'phase'.padEnd(12)} ` +
      `│ ${'queue'.padEnd(20)} ` +
      `│ ${'completed'.padStart(12)} ` +
      `│ ${'throughput'.padStart(12)} ` +
      `│ ${'p95'.padStart(11)} ` +
      `│ ${'rss'.padStart(8)} ` +
      `│ ${'wal'.padStart(7)} ` +
      `│ sq`,
  )
  console.log('─'.repeat(105))

  const sampleTimer = setInterval(() => {
    takeSample(currentPhase, currentRate)
  }, SAMPLE_INTERVAL_MS)

  // ── Emit loop ────────────────────────────────────────────────

  let currentPhase = ''
  let currentRate = 0
  let totalEmitted = 0

  for (const phase of config.phases) {
    currentPhase = phase.label
    currentRate = phase.eventsPerSec

    if (phase.eventsPerSec === 0) {
      await wait(phase.durationSec * 1000)
      continue
    }

    const intervalMs = 1000 / phase.eventsPerSec
    const phaseEnd = Date.now() + phase.durationSec * 1000

    while (Date.now() < phaseEnd) {
      const event = Math.random() < 0.8 ? 'load:start' : 'deep:start'
      try {
        engine.emit(event, randomPayload())
        totalEmitted++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED')) {
          sqliteErrors++
        }
      }
      await wait(intervalMs)
    }
  }

  // ── Drain remaining ──────────────────────────────────────────

  currentPhase = 'draining'
  currentRate = 0
  console.log('─'.repeat(105))
  console.log('  Draining remaining queue...')

  // Keep sampling during drain
  try {
    await engine.drain(DRAIN_TIMEOUT_MS)
  } catch {
    console.log('  Drain timed out — some runs still pending')
  }

  clearInterval(sampleTimer)
  takeSample('done', 0)

  printReport(engine, samples, startTime, totalEmitted, sqliteErrors)

  console.log('═'.repeat(80))
  console.log(`Dashboard: http://localhost:${DASHBOARD_PORT}`)
  console.log('Press Ctrl+C to stop')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
