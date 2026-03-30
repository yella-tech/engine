import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../../src/index.js'
import type { Engine, EngineObservabilityBucket, EngineEvent } from '../../src/types.js'
import { benchmarkScenarios, getBenchmarkScenario, type BenchmarkPhase, type BenchmarkScenario } from './scenarios.js'

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
  p95Ms: number | null
  runsPerSec: number
  walSizeBytes: number
}

type SeedCounters = {
  attempted: number
  admitted: number
  dropped: number
}

type ScenarioCounters = {
  byEvent: Record<string, SeedCounters>
  totals: SeedCounters
  effectsCompleted: number
  effectsErrored: number
  effectsReplayed: number
  retries: number
  deadLetters: number
  resumes: number
  leaseReclaims: number
  runErrors: number
  restartCount: number
}

const SAMPLE_INTERVAL_MS = 2_000
const DRAIN_TIMEOUT_MS = 5 * 60_000
const DEFAULT_REPORT_DIR = path.resolve('examples/reports/benchmarks')

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const fmt = (n: number) => n.toLocaleString()
const fmtMs = (n: number | null) => (n === null ? '-' : `${Math.round(n)}ms`)
const fmtMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`

class Logger {
  private readonly chunks: string[] = []

  line(text = '') {
    this.chunks.push(`${text}\n`)
    process.stdout.write(`${text}\n`)
  }

  write(text: string) {
    this.chunks.push(text)
    process.stdout.write(text)
  }

  toString() {
    return this.chunks.join('')
  }
}

function buildCounters(): ScenarioCounters {
  return {
    byEvent: {},
    totals: { attempted: 0, admitted: 0, dropped: 0 },
    effectsCompleted: 0,
    effectsErrored: 0,
    effectsReplayed: 0,
    retries: 0,
    deadLetters: 0,
    resumes: 0,
    leaseReclaims: 0,
    runErrors: 0,
    restartCount: 0,
  }
}

function tallyAdmission(counters: ScenarioCounters, eventName: string, admitted: number) {
  const entry = (counters.byEvent[eventName] ??= { attempted: 0, admitted: 0, dropped: 0 })
  entry.attempted++
  entry.admitted += admitted
  entry.dropped += admitted > 0 ? 0 : 1

  counters.totals.attempted++
  counters.totals.admitted += admitted
  counters.totals.dropped += admitted > 0 ? 0 : 1
}

function captureEvent(counters: ScenarioCounters, event: EngineEvent) {
  switch (event.type) {
    case 'effect:complete':
      counters.effectsCompleted++
      break
    case 'effect:error':
      counters.effectsErrored++
      break
    case 'effect:replay':
      counters.effectsReplayed++
      break
    case 'run:retry':
      counters.retries++
      break
    case 'run:dead':
      counters.deadLetters++
      break
    case 'run:resume':
      counters.resumes++
      break
    case 'lease:reclaim':
      counters.leaseReclaims++
      break
    case 'run:error':
      counters.runErrors++
      break
  }
}

function timestampForFilename(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function scalePhases(phases: BenchmarkPhase[], scale: number) {
  return phases.map((phase) => ({
    ...phase,
    durationSec: phase.eventsPerSec === 0 ? Math.max(5, Math.round(phase.durationSec * scale)) : Math.max(10, Math.round(phase.durationSec * scale)),
  }))
}

function createMachineSummary() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  }
}

function resolveScenarioSet(target: string): BenchmarkScenario[] {
  if (target === 'public') return benchmarkScenarios.filter((scenario) => scenario.visibility === 'public')
  if (target === 'internal') return benchmarkScenarios.filter((scenario) => scenario.visibility === 'internal')
  if (target === 'soak') return benchmarkScenarios.filter((scenario) => scenario.kind === 'soak')
  if (target === 'recovery') return benchmarkScenarios.filter((scenario) => scenario.kind === 'recovery')
  if (target === 'all') return benchmarkScenarios

  const scenario = getBenchmarkScenario(target)
  if (!scenario) throw new Error(`Unknown benchmark scenario or group: ${target}`)
  return [scenario]
}

function updateReportIndex(reportDir: string, summary: unknown) {
  const indexPath = path.resolve(reportDir, 'index.json')
  const existing = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : []
  existing.push(summary)
  fs.writeFileSync(indexPath, JSON.stringify(existing, null, 2))
}

async function runScenario(scenario: BenchmarkScenario, reportDir: string, scale: number) {
  fs.mkdirSync(reportDir, { recursive: true })
  fs.mkdirSync('_db/benchmarks', { recursive: true })

  const activePhases = scalePhases(scenario.phases, scale)
  const activeRestartSchedule = scenario.restartScheduleSec?.map((sec) => Math.max(5, Math.round(sec * scale))) ?? []
  const dbPath = path.resolve('_db/benchmarks', scenario.dbFile)
  for (const suffix of ['', '-wal', '-shm']) {
    const target = dbPath + suffix
    if (fs.existsSync(target)) fs.unlinkSync(target)
  }

  const logger = new Logger()
  const counters = buildCounters()
  const machine = createMachineSummary()
  const samples: Sample[] = []
  const startTime = Date.now()
  let currentPhase = ''
  let currentRate = 0
  let lastDone = 0
  let lastSampleTime = startTime
  let sqliteErrors = 0
  let restartCursor = 0
  let engine: Engine | null = null

  const createRuntime = () => {
    const created = createEngine({
      store: { type: 'sqlite', path: dbPath },
      concurrency: scenario.concurrency,
      maxChainDepth: scenario.maxChainDepth ?? 10,
      retry: scenario.retry,
      onEvent: (event) => captureEvent(counters, event),
      onRunError: (_run, error) => {
        if (error.includes('SQLITE_BUSY') || error.includes('SQLITE_LOCKED')) sqliteErrors++
      },
      onInternalError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SQLITE_BUSY') || message.includes('SQLITE_LOCKED')) sqliteErrors++
      },
    })
    scenario.register(created)
    return created
  }

  const maybeRestart = async () => {
    if (activeRestartSchedule.length === 0 || restartCursor >= activeRestartSchedule.length || !engine) return
    const elapsedSec = (Date.now() - startTime) / 1000
    if (elapsedSec < activeRestartSchedule[restartCursor]) return

    logger.line(`  Restart drill: cycling engine at ${Math.round(elapsedSec)}s`)
    counters.restartCount++
    await engine.stop()
    engine = createRuntime()
    restartCursor++
  }

  try {
    engine = createRuntime()

    logger.line()
    logger.line(`Yella Engine Benchmark  [${scenario.label}]`)
    logger.line('═'.repeat(96))
    logger.line(`  Scenario:      ${scenario.id}`)
    logger.line(`  Family:        ${scenario.family} (${scenario.kind}, ${scenario.visibility})`)
    logger.line(`  Description:   ${scenario.description}`)
    logger.line(`  Fleet conc.:   ${scenario.concurrency}`)
    logger.line(`  Duration:      ${activePhases.reduce((sum, phase) => sum + phase.durationSec, 0)}s across ${activePhases.length} phases`)
    logger.line(`  Seed attempts: ~${fmt(activePhases.reduce((sum, phase) => sum + phase.eventsPerSec * phase.durationSec, 0))}`)
    logger.line(`  Machine:       ${machine.cpus} CPU threads, ${fmtMB(machine.totalMemoryBytes)} RAM, ${machine.platform}/${machine.arch}`)
    if (scale !== 1) logger.line(`  Scale:         ${scale}x duration`)
    if (scenario.retry) logger.line(`  Retry policy:  ${scenario.retry.maxRetries} retries`)
    logger.line('  Notes:')
    for (const note of scenario.notes) logger.line(`    - ${note}`)
    logger.line()
    logger.line('  Phases:')
    for (const phase of activePhases) {
      logger.line(`    ${phase.label.padEnd(12)} ${String(phase.eventsPerSec).padStart(4)} events/s × ${phase.durationSec}s`)
    }
    logger.line('═'.repeat(96))
    logger.line()

    const takeSample = () => {
      if (!engine) return
      const now = Date.now()
      const elapsedSec = Math.round((now - startTime) / 1000)
      const metrics = engine.getMetrics()
      const obs = engine.getObservability({ from: startTime, to: now })
      const mem = process.memoryUsage()
      const deltaSeconds = (now - lastSampleTime) / 1000
      const done = metrics.queue.completed + metrics.queue.errored
      const runsPerSec = deltaSeconds > 0 ? Math.round(((done - lastDone) / deltaSeconds) * 10) / 10 : 0

      let walSizeBytes = 0
      try {
        walSizeBytes = fs.statSync(`${dbPath}-wal`).size
      } catch {}

      const sample: Sample = {
        elapsedSec,
        phase: currentPhase,
        emitRate: currentRate,
        idle: metrics.queue.idle,
        running: metrics.queue.running,
        completed: metrics.queue.completed,
        errored: metrics.queue.errored,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        p95Ms: obs.summary.runs.duration.p95Ms,
        runsPerSec,
        walSizeBytes,
      }

      samples.push(sample)
      lastDone = done
      lastSampleTime = now

      logger.write(
        `  ${String(sample.elapsedSec).padStart(4)}s ` +
          `│ ${sample.phase.padEnd(12)} ` +
          `│ q: ${String(sample.idle).padStart(5)} idle ${String(sample.running).padStart(3)} run ` +
          `│ done: ${fmt(sample.completed).padStart(7)} ` +
          `│ ${String(sample.runsPerSec).padStart(7)} run/s ` +
          `│ p95: ${fmtMs(sample.p95Ms).padStart(7)} ` +
          `│ rss: ${fmtMB(sample.rssBytes).padStart(5)} ` +
          `│ wal: ${fmtMB(sample.walSizeBytes).padStart(4)}\n`,
      )
    }

    logger.line(
      `  ${'t'.padStart(4)}s ` +
        `│ ${'phase'.padEnd(12)} ` +
        `│ ${'queue'.padEnd(20)} ` +
        `│ ${'completed'.padStart(12)} ` +
        `│ ${'throughput'.padStart(12)} ` +
        `│ ${'p95'.padStart(11)} ` +
        `│ ${'rss'.padStart(8)} ` +
        `│ ${'wal'.padStart(7)}`,
    )
    logger.line('─'.repeat(112))

    const sampleTimer = setInterval(() => {
      takeSample()
    }, SAMPLE_INTERVAL_MS)

    try {
      for (const phase of activePhases) {
        currentPhase = phase.label
        currentRate = phase.eventsPerSec
        scenario.onPhaseChange?.(phase)

        if (phase.eventsPerSec === 0) {
          const until = Date.now() + phase.durationSec * 1000
          while (Date.now() < until) {
            await maybeRestart()
            await wait(250)
          }
          continue
        }

        const intervalMs = 1000 / phase.eventsPerSec
        const phaseEnd = Date.now() + phase.durationSec * 1000

        while (Date.now() < phaseEnd) {
          await maybeRestart()
          const seed = scenario.nextSeed()
          try {
            const runs = engine.emit(seed.eventName, seed.payload, seed.idempotencyKey ? { idempotencyKey: seed.idempotencyKey } : undefined)
            tallyAdmission(counters, seed.eventName, runs.length)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('SQLITE_BUSY') || message.includes('SQLITE_LOCKED')) sqliteErrors++
            tallyAdmission(counters, seed.eventName, 0)
          }
          await wait(intervalMs)
        }
      }

      currentPhase = 'draining'
      currentRate = 0
      logger.line('─'.repeat(112))
      logger.line('  Draining remaining queue...')
      await engine.drain(DRAIN_TIMEOUT_MS)
    } finally {
      clearInterval(sampleTimer)
      takeSample()
    }

    const endTime = Date.now()
    const totalElapsed = (endTime - startTime) / 1000
    const metrics = engine.getMetrics()
    const observability = engine.getObservability({ from: startTime, to: endTime, bucketMs: 10_000 })
    const dbStat = fs.statSync(dbPath)
    const peakRssBytes = Math.max(...samples.map((sample) => sample.rssBytes), 0)
    const peakQueueDepth = Math.max(...samples.map((sample) => sample.idle + sample.running), 0)
    let walFileBytes = 0
    try {
      walFileBytes = fs.statSync(`${dbPath}-wal`).size
    } catch {}

    logger.line()
    logger.line('═'.repeat(96))
    logger.line(`Post-Mortem Report  [${scenario.label}]`)
    logger.line('═'.repeat(96))
    logger.line()
    logger.line('  Totals')
    logger.line('  ──────')
    logger.line(`    Duration:        ${Math.round(totalElapsed)}s`)
    logger.line(`    Seed attempts:   ${fmt(counters.totals.attempted)}`)
    logger.line(`    Seed admitted:   ${fmt(counters.totals.admitted)}`)
    logger.line(`    Seed dropped:    ${fmt(counters.totals.dropped)}`)
    logger.line(`    Runs completed:  ${fmt(metrics.queue.completed)}`)
    logger.line(`    Runs errored:    ${fmt(metrics.queue.errored)}`)
    logger.line(`    Retries:         ${fmt(counters.retries)}`)
    logger.line(`    Dead letters:    ${fmt(counters.deadLetters)}`)
    logger.line(`    Effect replays:  ${fmt(counters.effectsReplayed)}`)
    logger.line(`    Restarts:        ${fmt(counters.restartCount)}`)
    logger.line(`    SQLite errors:   ${fmt(sqliteErrors)}`)
    logger.line(`    Throughput:      ${Math.round((metrics.queue.completed + metrics.queue.errored) / totalElapsed)} runs/s avg`)
    logger.line()
    logger.line('  Seed Admission By Event')
    logger.line('  ───────────────────────')
    for (const [eventName, entry] of Object.entries(counters.byEvent).sort((a, b) => a[0].localeCompare(b[0]))) {
      logger.line(
        `    ${eventName.padEnd(24)} attempted ${fmt(entry.attempted).padStart(6)} ` +
          `admitted ${fmt(entry.admitted).padStart(6)} dropped ${fmt(entry.dropped).padStart(6)}`,
      )
    }
    logger.line()
    logger.line('  Run Duration')
    logger.line('  ────────────')
    logger.line(`    avg:  ${fmtMs(observability.summary.runs.duration.avgMs)}`)
    logger.line(`    p50:  ${fmtMs(observability.summary.runs.duration.p50Ms)}`)
    logger.line(`    p95:  ${fmtMs(observability.summary.runs.duration.p95Ms)}`)
    logger.line(`    max:  ${fmtMs(observability.summary.runs.duration.maxMs)}`)
    logger.line()
    logger.line('  Memory and Storage')
    logger.line('  ──────────────────')
    logger.line(`    Peak RSS:     ${fmtMB(peakRssBytes)}`)
    logger.line(`    Final RSS:    ${fmtMB(process.memoryUsage().rss)}`)
    logger.line(`    Peak queue:   ${fmt(peakQueueDepth)}`)
    logger.line(`    DB file:      ${fmtMB(dbStat.size)}`)
    logger.line(`    WAL file:     ${fmtMB(walFileBytes)}`)
    logger.line()

    if (observability.buckets.length > 0) {
      logger.line('  P95 Trend (10s buckets)')
      logger.line('  ───────────────────────')
      const activeBuckets = observability.buckets.filter((bucket: EngineObservabilityBucket) => bucket.runs.duration.count > 0)
      const maxP95 = Math.max(...activeBuckets.map((bucket) => bucket.runs.duration.p95Ms ?? 0), 1)
      for (const bucket of activeBuckets) {
        const sinceStart = Math.max(0, Math.round(((bucket.bucketStart + bucket.bucketSizeMs) - startTime) / 1000))
        const p95 = bucket.runs.duration.p95Ms
        const bar = p95 === null ? '' : '▓'.repeat(Math.max(1, Math.round(((p95 ?? 0) / maxP95) * 32)))
        logger.line(`    ${String(sinceStart).padStart(4)}s  ${fmtMs(p95).padStart(8)}  ${bar}`)
      }
      logger.line()
    }

    const stamp = timestampForFilename()
    const textPath = path.resolve(reportDir, `${scenario.id}__${stamp}.txt`)
    const jsonPath = path.resolve(reportDir, `${scenario.id}__${stamp}.json`)
    const summary = {
      scenario: {
        id: scenario.id,
        label: scenario.label,
        description: scenario.description,
        family: scenario.family,
        kind: scenario.kind,
        visibility: scenario.visibility,
        tags: scenario.tags,
        phases: activePhases,
        notes: scenario.notes,
        concurrency: scenario.concurrency,
      },
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date(endTime).toISOString(),
      machine,
      totals: {
        seedAttempts: counters.totals.attempted,
        seedAdmitted: counters.totals.admitted,
        seedDropped: counters.totals.dropped,
        runsCompleted: metrics.queue.completed,
        runsErrored: metrics.queue.errored,
        retries: counters.retries,
        deadLetters: counters.deadLetters,
        effectReplays: counters.effectsReplayed,
        restarts: counters.restartCount,
        sqliteErrors,
        throughputAvg: Math.round((metrics.queue.completed + metrics.queue.errored) / totalElapsed),
      },
      durations: observability.summary.runs.duration,
      memory: {
        peakRssBytes,
        finalRssBytes: process.memoryUsage().rss,
        peakQueueDepth,
        dbFileBytes: dbStat.size,
        walFileBytes,
      },
      effects: {
        completed: counters.effectsCompleted,
        errored: counters.effectsErrored,
        replayed: counters.effectsReplayed,
      },
      byEvent: counters.byEvent,
      reportFiles: {
        text: path.relative(process.cwd(), textPath),
        json: path.relative(process.cwd(), jsonPath),
      },
    }

    logger.line(`  Saved text report: ${path.relative(process.cwd(), textPath)}`)
    logger.line(`  Saved JSON summary: ${path.relative(process.cwd(), jsonPath)}`)

    fs.writeFileSync(textPath, logger.toString())
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2))
    updateReportIndex(reportDir, summary)
  } finally {
    if (engine) await engine.stop().catch(() => {})
  }
}

export async function runBenchmarkCli(args = process.argv.slice(2)) {
  const reportDirFlag = args.find((arg) => arg.startsWith('--report-dir='))
  const scaleFlag = args.find((arg) => arg.startsWith('--scale='))
  const reportDir = reportDirFlag ? path.resolve(reportDirFlag.slice('--report-dir='.length)) : DEFAULT_REPORT_DIR
  const scale = scaleFlag ? Number(scaleFlag.slice('--scale='.length)) : 1
  const filteredArgs = args.filter((arg) => !arg.startsWith('--report-dir=') && !arg.startsWith('--scale='))
  const target = filteredArgs[0] ?? 'list'

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid --scale value: ${scaleFlag}`)
  }

  if (target === 'list') {
    console.log('Available benchmark scenarios:')
    for (const scenario of benchmarkScenarios) {
      const durationMin = Math.round((scenario.phases.reduce((sum, phase) => sum + phase.durationSec, 0) / 60) * 10) / 10
      console.log(
        `  ${scenario.id.padEnd(44)} ${String(durationMin).padStart(5)}m  ${scenario.visibility.padEnd(8)} ${scenario.kind.padEnd(9)} ${scenario.description}`,
      )
    }
    console.log()
    console.log('Groups: public, internal, soak, recovery, all')
    return
  }

  const scenarios = resolveScenarioSet(target)
  for (const scenario of scenarios) {
    await runScenario(scenario, reportDir, scale)
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runBenchmarkCli().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
