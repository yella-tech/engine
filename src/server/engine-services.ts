import { getRunStatus, withRunStatus, withRunStatuses } from '../status.js'
import type { EngineEvent, EngineMetrics, EngineStreamEvent, ProcessState, Run, RunStatus } from '../types.js'
import { buildTraceGaps, buildTraceTree, flattenTrace } from './trace.js'
import type { RoutableEngine } from './contract.js'

interface EngineServiceClock {
  now: () => number
  uptime: () => number
}

type HealthPayload = {
  status: 'ok'
  uptime: number
  queue: EngineMetrics['queue']
  totals: EngineMetrics['totals']
  processes: Array<{ name: string; event: string }>
}

type ObservabilityWindowQuery = {
  from?: number
  to?: number
  windowMs?: number
  bucketMs?: number
  errorLimit?: number
}

export function defaultBucketMsForWindow(windowMs: number): number {
  if (windowMs <= 6 * 60 * 60_000) return 5 * 60_000
  if (windowMs <= 24 * 60 * 60_000) return 60 * 60_000
  if (windowMs <= 7 * 24 * 60 * 60_000) return 6 * 60 * 60_000
  return 24 * 60 * 60_000
}

function toStreamEvent(event: EngineEvent, now: number): EngineStreamEvent {
  switch (event.type) {
    case 'run:start':
    case 'run:complete':
    case 'run:error':
    case 'run:retry':
    case 'run:dead':
      return {
        kind: 'event',
        at: now,
        topics: ['health', 'runs', 'overview', 'observability', 'trace', 'graph', 'overlay'],
        eventType: event.type,
        runId: event.run.id,
        correlationId: event.run.correlationId,
        processName: event.run.processName,
        eventName: event.run.eventName,
      }

    case 'run:resume':
      return {
        kind: 'event',
        at: now,
        topics: ['health', 'runs', 'overview', 'observability', 'trace', 'graph', 'overlay'],
        eventType: event.type,
        runId: event.resumedRun.id,
        correlationId: event.resumedRun.correlationId,
        processName: event.resumedRun.processName,
        eventName: event.resumedRun.eventName,
      }

    case 'effect:complete':
    case 'effect:error':
    case 'effect:replay':
      return {
        kind: 'event',
        at: now,
        topics: ['observability', 'trace', 'overlay'],
        eventType: event.type,
        runId: event.runId,
        effectKey: event.effectKey,
      }

    case 'lease:reclaim':
      return {
        kind: 'event',
        at: now,
        topics: ['health', 'runs', 'overview', 'observability'],
        eventType: event.type,
        runId: event.run.id,
        correlationId: event.run.correlationId,
        processName: event.run.processName,
        eventName: event.run.eventName,
      }

    case 'internal:error':
      return {
        kind: 'event',
        at: now,
        topics: ['health', 'overview', 'observability'],
        eventType: event.type,
        context: event.context,
      }
  }
}

function sortChainRuns(runs: Run[]) {
  return [...runs].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.startedAt - b.startedAt)
}

function resolveRootRun(engine: RoutableEngine, run: Run): Run {
  let current = run
  while (current.parentRunId) {
    const parent = engine.getRun(current.parentRunId)
    if (!parent) break
    current = parent
  }
  return current
}

function buildHealthPayload(engine: RoutableEngine, uptime: number): HealthPayload {
  const metrics = engine.getMetrics()
  return {
    status: 'ok',
    uptime,
    queue: metrics.queue,
    totals: metrics.totals,
    processes: engine.getProcesses().map((process) => ({ name: process.name, event: process.eventName })),
  }
}

export function createEngineRouteServices(engine: RoutableEngine, clock: EngineServiceClock = { now: () => Date.now(), uptime: () => process.uptime() }) {
  return {
    live: {
      stream(signal: AbortSignal) {
        const encoder = new TextEncoder()
        let unsubscribe: (() => void) | null = null
        let heartbeat: ReturnType<typeof setInterval> | null = null
        let closed = false

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const cleanup = () => {
              if (closed) return
              closed = true
              if (heartbeat) clearInterval(heartbeat)
              heartbeat = null
              unsubscribe?.()
              unsubscribe = null
              try {
                controller.close()
              } catch {
                /* stream already closed */
              }
            }

            const send = (payload: EngineStreamEvent) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
              } catch {
                cleanup()
              }
            }

            send({ kind: 'connected', at: clock.now(), topics: [] })
            unsubscribe = engine.subscribeEvents((event) => {
              send(toStreamEvent(event, clock.now()))
            })
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'))
              } catch {
                cleanup()
              }
            }, 15_000)
            heartbeat.unref?.()
            signal.addEventListener('abort', cleanup, { once: true })
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            heartbeat = null
            unsubscribe?.()
            unsubscribe = null
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        })
      },
    },
    reads: {
      health() {
        return buildHealthPayload(engine, clock.uptime())
      },
      overview(opts: { limit: number; root: boolean; observabilityWindowMs?: number }) {
        const now = clock.now()
        const recentRuns = engine.getRunsPaginated(null, opts.limit, 0, { root: opts.root })
        const observability = opts.observabilityWindowMs ? engine.getObservability({ from: Math.max(0, now - opts.observabilityWindowMs), to: now }) : null

        return {
          health: buildHealthPayload(engine, clock.uptime()),
          recentRuns: {
            runs: withRunStatuses(recentRuns.runs),
            total: recentRuns.total,
          },
          observability: observability ? { summary: observability.summary } : null,
        }
      },
      metrics() {
        return engine.getMetrics()
      },
      observability(query: ObservabilityWindowQuery) {
        const to = query.to ?? clock.now()
        const from = query.from ?? (query.windowMs ? Math.max(0, to - query.windowMs) : undefined)
        const bucketMs = query.bucketMs ?? (query.windowMs ? defaultBucketMsForWindow(query.windowMs) : undefined)
        return engine.getObservability({ from, to, bucketMs, errorLimit: query.errorLimit })
      },
      runs(opts: { state: ProcessState | null; status: RunStatus | null; limit: number; offset: number; root: boolean; eventName?: string }) {
        const queryOpts = { root: opts.root, eventName: opts.eventName }
        const result = opts.status ? engine.getRunsByStatusPaginated(opts.status, opts.limit, opts.offset, queryOpts) : engine.getRunsPaginated(opts.state, opts.limit, opts.offset, queryOpts)

        return {
          runs: withRunStatuses(result.runs),
          total: result.total,
          offset: opts.offset,
        }
      },
      run(runId: string) {
        const run = engine.getRun(runId)
        return run ? withRunStatus(run) : null
      },
      chain(runId: string) {
        const run = engine.getRun(runId)
        if (!run) return null
        return { runs: withRunStatuses(engine.getChain(runId)) }
      },
      overlay(runId: string, selectedId?: string) {
        const run = engine.getRun(runId)
        if (!run) return null

        const rootRun = resolveRootRun(engine, run)
        const chain = withRunStatuses(sortChainRuns(engine.getChain(rootRun.id)))
        const selectedRun = chain.find((entry) => entry.id === selectedId) ?? chain.find((entry) => entry.id === run.id) ?? withRunStatus(run)
        const selectedStepIdx = Math.max(
          0,
          chain.findIndex((entry) => entry.id === selectedRun.id),
        )

        return {
          run: withRunStatus(run),
          rootRunId: rootRun.id,
          chain,
          selectedRun,
          selectedStepIdx,
          effects: engine.getEffects(selectedRun.id),
        }
      },
      trace(runId: string) {
        const run = engine.getRun(runId)
        if (!run) return null

        const chain = engine.getChain(runId)
        const tree = buildTraceTree(chain)
        const flat = flattenTrace(tree)
        const gaps = buildTraceGaps(chain)
        const timestamps = flat.flatMap((node) => [node.idleAt, node.runningAt, node.completedAt].filter((timestamp): timestamp is number => timestamp !== null))
        const minTime = timestamps.length ? Math.min(...timestamps) : 0
        const maxTime = timestamps.length ? Math.max(...timestamps) : 0
        const executionDurationMs = flat.reduce((total, span) => {
          if (span.runningAt === null || span.completedAt === null) return total
          return total + Math.max(span.completedAt - span.runningAt, 0)
        }, 0)
        const pausedDurationMs = gaps.reduce((total, gap) => total + gap.durationMs, 0)

        return {
          correlationId: run.correlationId,
          minTime,
          maxTime,
          durationMs: maxTime - minTime,
          executionDurationMs,
          pausedDurationMs,
          gaps,
          spans: flat,
        }
      },
      effects(runId: string) {
        const run = engine.getRun(runId)
        if (!run) return null
        return { effects: engine.getEffects(runId) }
      },
      graph() {
        return engine.getGraph()
      },
    },
    commands: {
      retry(runId: string) {
        const run = engine.retryRun(runId)
        return { id: run.id, state: run.state, status: getRunStatus(run) }
      },
      requeue(runId: string) {
        const run = engine.requeueDead(runId)
        return { id: run.id, state: run.state, status: getRunStatus(run) }
      },
      resume(runId: string, payload?: unknown) {
        const runs = engine.resume(runId, payload)
        return {
          resumed: true,
          runs: runs.map((run) => ({ id: run.id, process: run.processName, state: run.state, status: getRunStatus(run) })),
        }
      },
      emit(event: string, payload: unknown, idempotencyKey?: string) {
        const runs = engine.emit(event, payload, idempotencyKey ? { idempotencyKey } : undefined)
        return {
          created: runs.length,
          runs: runs.map((run) => ({ id: run.id, process: run.processName, state: run.state, status: getRunStatus(run) })),
        }
      },
    },
  }
}
