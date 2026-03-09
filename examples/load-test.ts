import fs from 'node:fs'
import crypto from 'node:crypto'
import { createEngine } from '../src/index.js'

// ─── Config ──────────────────────────────────────────────────

const CONCURRENCY_LEVELS = Array.from({ length: 20 }, (_, i) => i + 1)
const SHALLOW_EVENTS = 100 // seed events for shallow chain
const DEEP_EVENTS = 20 // seed events for deep chain
const DB_PATH = '_db/load-test.db'
const DRAIN_TIMEOUT_MS = 60_000
const DASHBOARD_PORT = 3400

// Helper: random delay between min and max ms
const delay = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)))

// Random hex payload
const randomPayload = () => ({ data: crypto.randomBytes(32).toString('hex'), ts: Date.now() })

// ─── Register handlers on an engine ──────────────────────────

function registerHandlers(engine: ReturnType<typeof createEngine>) {
  // ── Shallow chain (3 levels + fan-out) ──────────────────
  // load:start -> load:validated -> load:done (x2 fan-out at end)

  engine.process({
    name: 'load-validate',
    on: 'load:start',
    run: async (ctx) => {
      await delay(5, 30)
      ctx.setContext('validatedAt', Date.now())
      return ctx.ok({ valid: true }, { emit: 'load:validated' })
    },
  })

  engine.process({
    name: 'load-process',
    on: 'load:validated',
    run: async (ctx) => {
      await delay(5, 40)
      ctx.setContext('processedBy', 'worker-' + Math.floor(Math.random() * 10))
      return ctx.ok({ processed: true }, { emit: 'load:done' })
    },
  })

  // Fan-out: two handlers on load:done
  engine.process({
    name: 'load-notify',
    on: 'load:done',
    run: async (ctx) => {
      await delay(5, 20)
      return ctx.ok({ notified: true })
    },
  })

  engine.process({
    name: 'load-archive',
    on: 'load:done',
    run: async (ctx) => {
      await delay(5, 25)
      return ctx.ok({ archived: true })
    },
  })

  // ── Deep chain (7 levels with effects) ──────────────────
  // deep:start -> deep:s1 -> deep:s2 -> deep:s3 -> deep:s4 -> deep:s5 -> deep:done

  const deepSteps = ['deep:start', 'deep:s1', 'deep:s2', 'deep:s3', 'deep:s4', 'deep:s5']

  for (let i = 0; i < deepSteps.length; i++) {
    const from = deepSteps[i]
    const to = i < deepSteps.length - 1 ? deepSteps[i + 1] : 'deep:done'
    const useEffect = i === 1 || i === 4 // effects on steps 2 and 5

    engine.process({
      name: `deep-step-${i}`,
      on: from,
      run: async (ctx) => {
        await delay(5, 50)
        ctx.setContext(`step${i}`, Date.now())

        if (useEffect) {
          await ctx.effect({
            key: `compute-${i}`,
            run: async () => {
              await delay(2, 10)
              return { hash: crypto.randomBytes(8).toString('hex') }
            },
          })
        }

        return ctx.ok({ step: i, ok: true }, { emit: to })
      },
    })
  }

  // Terminal handler for deep chain
  engine.process({
    name: 'deep-finish',
    on: 'deep:done',
    run: async (ctx) => {
      await delay(5, 15)
      return ctx.ok({ depth: 7, completed: true })
    },
  })
}

// ─── Expected runs per seed event ────────────────────────────
// Shallow: 1 seed -> validate -> process -> notify + archive = 4 runs
// Deep: 1 seed -> 6 steps + finish = 7 runs

const RUNS_PER_SHALLOW = 4
const RUNS_PER_DEEP = 7
const TOTAL_SEED_EVENTS = SHALLOW_EVENTS + DEEP_EVENTS
const EXPECTED_RUNS = SHALLOW_EVENTS * RUNS_PER_SHALLOW + DEEP_EVENTS * RUNS_PER_DEEP

// ─── Run a single concurrency level ─────────────────────────

type Result = {
  concurrency: number
  seedEvents: number
  expectedRuns: number
  completed: number
  errored: number
  timeMs: number
  runsPerSec: number
  failed: boolean
  failReason?: string
}

async function runLevel(concurrency: number, withServer: boolean): Promise<Result> {
  // Fresh DB each run
  fs.mkdirSync('_db', { recursive: true })
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH)

  const engine = createEngine({
    store: { type: 'sqlite', path: DB_PATH },
    concurrency,
    maxChainDepth: 10,
    ...(withServer ? { server: { port: DASHBOARD_PORT } } : {}),
  })

  registerHandlers(engine)

  if (withServer) {
    const server = await engine.getServer()!
    console.log(`\nDashboard: http://${server.address.host}:${server.address.port}\n`)
  }

  const start = performance.now()

  // Fire shallow chain seeds
  for (let i = 0; i < SHALLOW_EVENTS; i++) {
    engine.emit('load:start', randomPayload())
  }

  // Fire deep chain seeds
  for (let i = 0; i < DEEP_EVENTS; i++) {
    engine.emit('deep:start', randomPayload())
  }

  let failed = false
  let failReason: string | undefined

  try {
    await engine.drain(DRAIN_TIMEOUT_MS)
  } catch (e: any) {
    failed = true
    failReason = e.message ?? String(e)
  }

  const elapsed = performance.now() - start
  const completed = engine.getCompleted().length
  const errored = engine.getErrored().length

  if (errored > 0 && !failed) {
    failed = true
    failReason = `${errored} runs errored`
  }

  if (!withServer) {
    await engine.stop()
  }

  return {
    concurrency,
    seedEvents: TOTAL_SEED_EVENTS,
    expectedRuns: EXPECTED_RUNS,
    completed,
    errored,
    timeMs: Math.round(elapsed),
    runsPerSec: Math.round((completed / elapsed) * 1000 * 10) / 10,
    failed,
    failReason,
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('Yella Engine Load Test')
  console.log('═'.repeat(70))
  console.log(`Shallow chains: ${SHALLOW_EVENTS} seeds × ${RUNS_PER_SHALLOW} runs = ${SHALLOW_EVENTS * RUNS_PER_SHALLOW} runs`)
  console.log(`Deep chains:    ${DEEP_EVENTS} seeds × ${RUNS_PER_DEEP} runs = ${DEEP_EVENTS * RUNS_PER_DEEP} runs`)
  console.log(`Total expected: ${EXPECTED_RUNS} runs per level`)
  console.log(`Concurrency:    ${CONCURRENCY_LEVELS[0]}-${CONCURRENCY_LEVELS[CONCURRENCY_LEVELS.length - 1]}`)
  console.log('═'.repeat(70))
  console.log()

  const results: Result[] = []

  for (const level of CONCURRENCY_LEVELS) {
    const isLast = level === CONCURRENCY_LEVELS[CONCURRENCY_LEVELS.length - 1]
    process.stdout.write(`  concurrency=${String(level).padStart(2)}  `)

    const result = await runLevel(level, isLast)
    results.push(result)

    const status = result.failed ? `FAIL: ${result.failReason}` : 'ok'
    console.log(`${result.completed}/${result.expectedRuns} runs  ${result.timeMs}ms  ${result.runsPerSec} runs/s  ${status}`)
  }

  // ── Summary table ──────────────────────────────────────────
  console.log()
  console.log('═'.repeat(70))
  console.log('Summary')
  console.log('═'.repeat(70))
  console.log()

  const header = ['Concurrency', 'Completed', 'Errored', 'Time(ms)', 'Runs/sec', 'Status']
  const widths = [11, 9, 7, 8, 8, 30]

  console.log(header.map((h, i) => h.padStart(widths[i])).join(' │ '))
  console.log(widths.map((w) => '─'.repeat(w)).join('─┼─'))

  for (const r of results) {
    const status = r.failed ? `FAIL: ${r.failReason}` : 'ok'
    const row = [
      String(r.concurrency).padStart(widths[0]),
      String(r.completed).padStart(widths[1]),
      String(r.errored).padStart(widths[2]),
      String(r.timeMs).padStart(widths[3]),
      String(r.runsPerSec).padStart(widths[4]),
      status.padStart(widths[5]),
    ]
    console.log(row.join(' │ '))
  }

  // ── Peak throughput ────────────────────────────────────────
  const peak = results.reduce((a, b) => (a.runsPerSec > b.runsPerSec ? a : b))
  console.log()
  console.log(`Peak throughput: ${peak.runsPerSec} runs/sec at concurrency=${peak.concurrency}`)

  const failures = results.filter((r) => r.failed)
  if (failures.length > 0) {
    console.log(`Failures at: ${failures.map((f) => `concurrency=${f.concurrency}`).join(', ')}`)
  }

  // Keep alive for dashboard on last level
  const lastResult = results[results.length - 1]
  if (!lastResult.failed) {
    console.log(`\nDashboard running on http://localhost:${DASHBOARD_PORT}`)
    console.log('Press Ctrl+C to stop')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
