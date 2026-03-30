import crypto from 'node:crypto'
import { createEngine } from '../../src/index.js'

export type BenchmarkFamily =
  | 'api-mixed'
  | 'scraper-bounded'
  | 'burst-recovery'
  | 'degraded-downstream'
  | 'overnight-soak'
  | 'restart-drill'

export type BenchmarkKind = 'benchmark' | 'soak' | 'recovery'
export type BenchmarkVisibility = 'public' | 'internal'

export type BenchmarkPhase = {
  label: string
  eventsPerSec: number
  durationSec: number
}

export type BenchmarkSeed = {
  eventName: string
  payload: unknown
  idempotencyKey?: string
}

export type BenchmarkScenario = {
  id: string
  label: string
  description: string
  family: BenchmarkFamily
  kind: BenchmarkKind
  visibility: BenchmarkVisibility
  tags: string[]
  dbFile: string
  concurrency: number
  retry?: { maxRetries: number; delay: number | ((attempt: number) => number) }
  maxChainDepth?: number
  phases: BenchmarkPhase[]
  notes: string[]
  restartScheduleSec?: number[]
  register: (engine: ReturnType<typeof createEngine>) => void
  nextSeed: () => BenchmarkSeed
  onPhaseChange?: (phase: BenchmarkPhase) => void
}

type DelayProfile = {
  baseMs: readonly [number, number]
  outlierRate?: number
  outlierMs?: readonly [number, number]
}

type FailureProfile = {
  transientRate?: number
  permanentRate?: number
}

type DegradationMode = 'healthy' | 'slow' | 'rate-limited' | 'recovering'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

async function delay(profile: DelayProfile): Promise<void> {
  if (profile.outlierRate && profile.outlierMs && Math.random() < profile.outlierRate) {
    await wait(randomBetween(profile.outlierMs[0], profile.outlierMs[1]))
    return
  }
  await wait(randomBetween(profile.baseMs[0], profile.baseMs[1]))
}

function throwTransient(profile: FailureProfile) {
  if (!profile.transientRate || Math.random() >= profile.transientRate) return
  const errors = [
    'HTTP 429: downstream rate limit',
    'HTTP 503: downstream unavailable',
    'ETIMEDOUT: downstream timeout',
    'ECONNRESET: downstream reset connection',
  ]
  throw new Error(errors[Math.floor(Math.random() * errors.length)])
}

function shouldPermanentlyFail(profile: FailureProfile) {
  return Boolean(profile.permanentRate && Math.random() < profile.permanentRate)
}

function pickWeighted<T>(entries: Array<{ weight: number; value: T }>): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = Math.random() * total
  for (const entry of entries) {
    cursor -= entry.weight
    if (cursor <= 0) return entry.value
  }
  return entries[entries.length - 1].value
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

function buildApiMixedWorkload(options?: {
  concurrency?: number
  degradedMode?: () => DegradationMode
  scraperConcurrency?: number
  scraperMemoryMb?: number
  includeScraper?: boolean
  scraperWeight?: number
}) {
  const degradedMode = options?.degradedMode ?? (() => 'healthy' as const)
  const scraperMemoryMb = options?.scraperMemoryMb ?? 24
  const includeScraper = options?.includeScraper ?? false
  const scraperWeight = options?.scraperWeight ?? 3

  const transientForMode = (): FailureProfile => {
    switch (degradedMode()) {
      case 'slow':
        return { transientRate: 0.04, permanentRate: 0.004 }
      case 'rate-limited':
        return { transientRate: 0.09, permanentRate: 0.008 }
      case 'recovering':
        return { transientRate: 0.03, permanentRate: 0.004 }
      case 'healthy':
      default:
        return { transientRate: 0.02, permanentRate: 0.003 }
    }
  }

  const latencyForMode = (healthy: readonly [number, number], degraded: readonly [number, number]): DelayProfile => {
    const mode = degradedMode()
    if (mode === 'healthy') return { baseMs: healthy, outlierRate: 0.03, outlierMs: [800, 1800] }
    if (mode === 'recovering') return { baseMs: [healthy[0] * 1.5, healthy[1] * 1.5] as const, outlierRate: 0.05, outlierMs: [1200, 2400] }
    return { baseMs: degraded, outlierRate: 0.08, outlierMs: [2000, 5000] }
  }

  return {
    register(engine: ReturnType<typeof createEngine>) {
      engine.process({
        name: 'webhook-validate',
        on: 'webhook:received',
        emits: ['webhook:validated'],
        run: async (ctx) => {
          await delay({ baseMs: [8, 35], outlierRate: 0.01, outlierMs: [300, 700] })
          if (shouldPermanentlyFail({ permanentRate: degradedMode() === 'rate-limited' ? 0.015 : 0.01 })) {
            return ctx.fail('schema rejected payload')
          }
          ctx.setContext('tenantId', (ctx.payload as { tenantId: string }).tenantId)
          return ctx.ok({ accepted: true }, { emit: 'webhook:validated' })
        },
      })

      engine.process({
        name: 'crm-upsert',
        on: 'webhook:validated',
        emits: ['webhook:synced'],
        run: async (ctx) => {
          await delay(latencyForMode([140, 420], [320, 1200]))
          throwTransient(transientForMode())
          if (shouldPermanentlyFail({ permanentRate: degradedMode() === 'rate-limited' ? 0.007 : 0.003 })) {
            return ctx.fail('crm rejected the write')
          }
          await ctx.effect({
            key: ['crm-upsert', (ctx.payload as { customerId?: string }).customerId ?? ctx.runId],
            run: async () => {
              await delay(latencyForMode([80, 220], [180, 480]))
              return { remoteId: `crm_${crypto.randomBytes(4).toString('hex')}` }
            },
          })
          return ctx.ok({ synced: true }, { emit: 'webhook:synced' })
        },
      })

      engine.process({
        name: 'ops-notify',
        on: 'webhook:synced',
        run: async () => {
          await delay(latencyForMode([30, 90], [120, 300]))
          throwTransient({ transientRate: degradedMode() === 'rate-limited' ? 0.03 : 0.01 })
          return { success: true }
        },
      })

      engine.process({
        name: 'billing-reconcile',
        on: 'billing:sync-requested',
        emits: ['billing:reconciled'],
        run: async (ctx) => {
          await delay(latencyForMode([180, 520], [400, 1400]))
          throwTransient(transientForMode())
          await ctx.effect({
            key: ['billing-fetch', (ctx.payload as { invoiceId: string }).invoiceId],
            run: async () => {
              await delay(latencyForMode([70, 180], [160, 400]))
              return { amount: Math.round(randomBetween(1000, 70000)) }
            },
          })
          return ctx.ok({ reconciled: true }, { emit: 'billing:reconciled' })
        },
      })

      engine.process({
        name: 'billing-audit',
        on: 'billing:reconciled',
        run: async (ctx) => {
          await delay({ baseMs: [35, 110] })
          if (shouldPermanentlyFail({ permanentRate: 0.002 })) {
            return ctx.fail('audit policy rejected reconciliation')
          }
          return ctx.ok({ audit: 'stored', invoiceId: (ctx.payload as { invoiceId?: string }).invoiceId ?? null })
        },
      })

      engine.process({
        name: 'document-extract',
        on: 'document:index-requested',
        emits: ['document:indexed'],
        run: async (ctx) => {
          await delay(latencyForMode([90, 260], [200, 700]))
          throwTransient({ transientRate: degradedMode() === 'rate-limited' ? 0.04 : 0.015 })
          await ctx.effect({
            key: ['extract', (ctx.payload as { documentId: string }).documentId],
            run: async () => {
              await delay(latencyForMode([60, 140], [150, 280]))
              return { embeddings: 8 }
            },
          })
          return ctx.ok({ indexed: true }, { emit: 'document:indexed' })
        },
      })

      engine.process({
        name: 'search-refresh',
        on: 'document:indexed',
        run: async () => {
          await delay({ baseMs: [25, 70] })
          return { success: true }
        },
      })

      engine.process({
        name: 'approval-stage',
        on: 'approval:needed',
        run: async (ctx) => {
          await delay({ baseMs: [15, 45] })
          return ctx.ok({ queued: true }, { emit: 'approval:completed' })
        },
      })

      engine.process({
        name: 'approval-finish',
        on: 'approval:completed',
        run: async () => {
          await delay({ baseMs: [20, 60] })
          return { success: true }
        },
      })

      if (includeScraper) {
        engine.process({
          name: 'browser-scrape',
          on: 'page:scrape-requested',
          concurrency: options?.scraperConcurrency,
          emits: ['page:scraped'],
          run: async (ctx) => {
            const sizeBytes = scraperMemoryMb * 1024 * 1024
            const buffer = Buffer.allocUnsafe(sizeBytes)
            for (let offset = 0; offset < sizeBytes; offset += 4096) {
              buffer[offset] = offset % 251
            }

            await delay(latencyForMode([700, 1300], [1400, 3200]))
            throwTransient({ transientRate: degradedMode() === 'rate-limited' ? 0.05 : 0.02 })

            await ctx.effect({
              key: ['browser-store', (ctx.payload as { url: string }).url],
              run: async () => {
                await delay({ baseMs: [120, 260] })
                return { screenshotHash: crypto.createHash('sha1').update(buffer.subarray(0, 2048)).digest('hex').slice(0, 12) }
              },
            })

            return ctx.ok({ scraped: true }, { emit: 'page:scraped' })
          },
        })

        engine.process({
          name: 'page-followup',
          on: 'page:scraped',
          run: async () => {
            await delay({ baseMs: [30, 90] })
            return { success: true }
          },
        })
      }
    },

    nextSeed() {
      const baseEntries: Array<{ weight: number; value: BenchmarkSeed }> = [
        {
          weight: 5,
          value: {
            eventName: 'webhook:received',
            payload: {
              tenantId: randomId('tenant'),
              customerId: randomId('cust'),
              eventType: pickWeighted([
                { weight: 6, value: 'customer.updated' },
                { weight: 2, value: 'subscription.updated' },
                { weight: 1, value: 'invoice.paid' },
              ]),
            },
          },
        },
        {
          weight: 3,
          value: {
            eventName: 'billing:sync-requested',
            payload: {
              accountId: randomId('acct'),
              invoiceId: randomId('inv'),
              source: pickWeighted([
                { weight: 4, value: 'stripe' },
                { weight: 1, value: 'paddle' },
              ]),
            },
          },
        },
        {
          weight: 2,
          value: {
            eventName: 'document:index-requested',
            payload: {
              documentId: randomId('doc'),
              sizeKb: Math.round(randomBetween(40, 1400)),
              source: pickWeighted([
                { weight: 3, value: 'email' },
                { weight: 2, value: 'upload' },
                { weight: 1, value: 'notion' },
              ]),
            },
          },
        },
        {
          weight: 1,
          value: {
            eventName: 'approval:needed',
            payload: {
              approvalId: randomId('approval'),
              actor: pickWeighted([
                { weight: 2, value: 'ops' },
                { weight: 1, value: 'finance' },
              ]),
            },
          },
        },
      ]

      if (includeScraper) {
        baseEntries.push({
          weight: scraperWeight,
          value: {
            eventName: 'page:scrape-requested',
            payload: {
              tenantId: randomId('tenant'),
              url: `https://example.com/${crypto.randomBytes(3).toString('hex')}`,
              waitUntil: pickWeighted([
                { weight: 4, value: 'networkidle' },
                { weight: 1, value: 'load' },
              ]),
            },
          },
        })
      }

      return pickWeighted(baseEntries)
    },
  }
}

function makeApiMixedScenario(concurrency: number): BenchmarkScenario {
  const workload = buildApiMixedWorkload()
  const rateBase = Math.max(4, Math.round(concurrency / 5))

  return {
    id: `api-mixed__fleet-c${concurrency}`,
    label: `API mixed workload (fleet concurrency ${concurrency})`,
    description: 'Mixed webhook, billing, document, and approval automation with retries, outliers, and durable effects.',
    family: 'api-mixed',
    kind: 'benchmark',
    visibility: 'public',
    tags: ['sqlite', 'wal', 'retries', 'concurrency-sweep'],
    dbFile: `api-mixed-c${concurrency}.db`,
    concurrency,
    retry: { maxRetries: 2, delay: (attempt) => 300 * Math.pow(2, attempt) },
    maxChainDepth: 10,
    phases: [
      { label: 'warm-up', eventsPerSec: Math.max(2, Math.round(rateBase / 3)), durationSec: 30 },
      { label: 'steady', eventsPerSec: rateBase, durationSec: 90 },
      { label: 'peak', eventsPerSec: rateBase * 2, durationSec: 120 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    notes: [
      'Global concurrency is the only limit in this scenario.',
      'Root events fan out into 2-3 stage chains with durable effects.',
      'This is the public benchmark family used for the site performance page.',
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
  }
}

function makeScraperBoundedScenario(scraperConcurrency: number): BenchmarkScenario {
  const fleetConcurrency = 40
  const workload = buildApiMixedWorkload({
    includeScraper: true,
    scraperConcurrency,
    scraperMemoryMb: 24,
    scraperWeight: 3,
  })

  return {
    id: `scraper-bounded__fleet-c${fleetConcurrency}__scraper-c${scraperConcurrency}`,
    label: `Bounded scraper workload (fleet ${fleetConcurrency}, scraper ${scraperConcurrency})`,
    description: 'Mixed automation where a memory-heavy browser task is capped independently from the rest of the engine.',
    family: 'scraper-bounded',
    kind: 'benchmark',
    visibility: 'public',
    tags: ['memory', 'scraper', 'bounded-concurrency'],
    dbFile: `scraper-bounded-fleet40-scraper${scraperConcurrency}.db`,
    concurrency: fleetConcurrency,
    retry: { maxRetries: 1, delay: 400 },
    maxChainDepth: 10,
    phases: [
      { label: 'warm-up', eventsPerSec: 6, durationSec: 30 },
      { label: 'steady', eventsPerSec: 18, durationSec: 90 },
      { label: 'burst', eventsPerSec: 36, durationSec: 120 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    notes: [
      'The browser-like scraper allocates about 24MB per active run.',
      `The scraper process has its own concurrency cap of ${scraperConcurrency}.`,
      'This shows how memory-heavy tasks can be bounded without lowering the whole fleet limit.',
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
  }
}

function makeBurstRecoveryScenario(includeScraper: boolean): BenchmarkScenario {
  const workload = buildApiMixedWorkload({
    includeScraper,
    scraperConcurrency: includeScraper ? 5 : undefined,
    scraperMemoryMb: 24,
    scraperWeight: includeScraper ? 3 : undefined,
  })

  return {
    id: includeScraper ? 'burst-recovery__scraper-capped' : 'burst-recovery__fleet-c50',
    label: includeScraper ? 'Burst recovery with capped scraper' : 'Burst recovery (fleet concurrency 50)',
    description: 'Steady load, sharp burst, then recovery to show queue build-up and drain behavior.',
    family: 'burst-recovery',
    kind: 'benchmark',
    visibility: 'internal',
    tags: ['burst', 'recovery', ...(includeScraper ? ['scraper'] : ['api'])],
    dbFile: includeScraper ? 'burst-recovery-scraper-capped.db' : 'burst-recovery-fleet50.db',
    concurrency: 50,
    retry: { maxRetries: 2, delay: (attempt) => 300 * Math.pow(2, attempt) },
    phases: [
      { label: 'steady', eventsPerSec: includeScraper ? 12 : 20, durationSec: 60 },
      { label: 'surge', eventsPerSec: includeScraper ? 28 : 55, durationSec: 60 },
      { label: 'spike', eventsPerSec: includeScraper ? 45 : 90, durationSec: 60 },
      { label: 'recovery', eventsPerSec: includeScraper ? 10 : 15, durationSec: 60 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    notes: [
      'The queue should grow during the surge and spike phases.',
      'The important signal is whether the system drains and stabilizes when the rate falls.',
      ...(includeScraper ? ['The scraper cap should keep RSS steadier during the spike.'] : []),
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
  }
}

function makeDegradedDownstreamScenario(includeScraper: boolean): BenchmarkScenario {
  let degradation: DegradationMode = 'healthy'
  const workload = buildApiMixedWorkload({
    includeScraper,
    scraperConcurrency: includeScraper ? 5 : undefined,
    scraperMemoryMb: 24,
    scraperWeight: includeScraper ? 2 : undefined,
    degradedMode: () => degradation,
  })

  return {
    id: includeScraper ? 'degraded-downstream__scraper-capped' : 'degraded-downstream__api-mixed',
    label: includeScraper ? 'Degraded downstream with capped scraper' : 'Degraded downstream (API mixed)',
    description: 'Injects slower calls and rate-limited downstream behavior to show retries, dead letters, and degraded throughput.',
    family: 'degraded-downstream',
    kind: 'benchmark',
    visibility: 'internal',
    tags: ['degradation', 'retries', ...(includeScraper ? ['scraper'] : ['api'])],
    dbFile: includeScraper ? 'degraded-downstream-scraper-capped.db' : 'degraded-downstream-api.db',
    concurrency: includeScraper ? 40 : 50,
    retry: { maxRetries: 2, delay: (attempt) => 400 * Math.pow(2, attempt) },
    phases: [
      { label: 'healthy', eventsPerSec: includeScraper ? 14 : 22, durationSec: 60 },
      { label: 'slow', eventsPerSec: includeScraper ? 18 : 30, durationSec: 60 },
      { label: 'rate-limited', eventsPerSec: includeScraper ? 18 : 30, durationSec: 60 },
      { label: 'recovering', eventsPerSec: includeScraper ? 14 : 22, durationSec: 60 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    notes: [
      'The workload deliberately changes downstream conditions by phase.',
      'This scenario exists to show retry recovery versus terminal failure behavior.',
      ...(includeScraper ? ['Expensive browser tasks remain capped while downstream APIs degrade.'] : []),
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
    onPhaseChange(phase) {
      if (phase.label === 'healthy') degradation = 'healthy'
      else if (phase.label === 'slow') degradation = 'slow'
      else if (phase.label === 'rate-limited') degradation = 'rate-limited'
      else if (phase.label === 'recovering') degradation = 'recovering'
    },
  }
}

function makeOvernightSoakScenario(includeScraper: boolean): BenchmarkScenario {
  const workload = buildApiMixedWorkload({
    includeScraper,
    scraperConcurrency: includeScraper ? 5 : undefined,
    scraperMemoryMb: 24,
    scraperWeight: includeScraper ? 2 : undefined,
  })

  return {
    id: includeScraper ? 'overnight-soak__scraper-bounded' : 'overnight-soak__api-mixed',
    label: includeScraper ? 'Overnight soak with bounded scraper' : 'Overnight soak (API mixed)',
    description: 'Long-running stability test for memory, WAL growth, retries, and queue recovery.',
    family: 'overnight-soak',
    kind: 'soak',
    visibility: 'internal',
    tags: ['overnight', 'soak', ...(includeScraper ? ['scraper'] : ['api'])],
    dbFile: includeScraper ? 'overnight-soak-scraper-bounded.db' : 'overnight-soak-api-mixed.db',
    concurrency: includeScraper ? 40 : 50,
    retry: { maxRetries: 2, delay: (attempt) => 500 * Math.pow(2, attempt) },
    phases: [
      { label: 'warm-up', eventsPerSec: includeScraper ? 8 : 12, durationSec: 15 * 60 },
      { label: 'steady-a', eventsPerSec: includeScraper ? 12 : 18, durationSec: 90 * 60 },
      { label: 'burst-a', eventsPerSec: includeScraper ? 22 : 35, durationSec: 30 * 60 },
      { label: 'steady-b', eventsPerSec: includeScraper ? 12 : 18, durationSec: 90 * 60 },
      { label: 'burst-b', eventsPerSec: includeScraper ? 22 : 35, durationSec: 30 * 60 },
      { label: 'steady-c', eventsPerSec: includeScraper ? 12 : 18, durationSec: 90 * 60 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 15 * 60 },
    ],
    notes: [
      'This is an internal trust test, not a site benchmark.',
      'Run this on the same machine class you use in production.',
      'The important signals are RSS stability, WAL/DB growth, retry counts, and whether the queue fully recovers after each burst.',
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
  }
}

function makeRestartDrillScenario(includeScraper: boolean): BenchmarkScenario {
  const workload = buildApiMixedWorkload({
    includeScraper,
    scraperConcurrency: includeScraper ? 5 : undefined,
    scraperMemoryMb: 24,
    scraperWeight: includeScraper ? 2 : undefined,
  })

  return {
    id: includeScraper ? 'crash-recovery__mid-load__scraper-bounded' : 'crash-recovery__mid-load__api-mixed',
    label: includeScraper ? 'Restart drill during scraper load' : 'Restart drill during API mixed load',
    description: 'Deliberate hard restart during active load to exercise restart/recovery behavior against a live SQLite store.',
    family: 'restart-drill',
    kind: 'recovery',
    visibility: 'internal',
    tags: ['restart', 'recovery', ...(includeScraper ? ['scraper'] : ['api'])],
    dbFile: includeScraper ? 'restart-drill-scraper-bounded.db' : 'restart-drill-api-mixed.db',
    concurrency: includeScraper ? 40 : 50,
    retry: { maxRetries: 2, delay: (attempt) => 400 * Math.pow(2, attempt) },
    phases: [
      { label: 'warm-up', eventsPerSec: includeScraper ? 10 : 16, durationSec: 60 },
      { label: 'active-load', eventsPerSec: includeScraper ? 20 : 35, durationSec: 180 },
      { label: 'post-restart', eventsPerSec: includeScraper ? 16 : 28, durationSec: 120 },
      { label: 'cool-down', eventsPerSec: 0, durationSec: 60 },
    ],
    restartScheduleSec: [120],
    notes: [
      'The runner performs a deliberate hard restart against the same SQLite database.',
      'This is a restart drill, not a SIGKILL chaos test.',
      'Use it to validate that the queue continues after restart and that memory settles again.',
    ],
    register: workload.register,
    nextSeed: workload.nextSeed,
  }
}

export const benchmarkScenarios: BenchmarkScenario[] = [
  makeApiMixedScenario(20),
  makeApiMixedScenario(50),
  makeApiMixedScenario(200),
  makeScraperBoundedScenario(1),
  makeScraperBoundedScenario(5),
  makeScraperBoundedScenario(10),
  makeBurstRecoveryScenario(false),
  makeBurstRecoveryScenario(true),
  makeDegradedDownstreamScenario(false),
  makeDegradedDownstreamScenario(true),
  makeOvernightSoakScenario(false),
  makeOvernightSoakScenario(true),
  makeRestartDrillScenario(false),
  makeRestartDrillScenario(true),
]

export function getBenchmarkScenario(id: string): BenchmarkScenario | undefined {
  return benchmarkScenarios.find((scenario) => scenario.id === id)
}
