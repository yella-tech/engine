import crypto from 'node:crypto'
import type { HandlerResult, ProcessState, Run, RunStore, TimelineEntry } from './types.js'
import { VALID_TRANSITIONS } from './types.js'

export function createRunStore(): RunStore {
  const runs = new Map<string, Run>()

  function cloneValue<T>(value: T): T {
    try {
      return structuredClone(value)
    } catch {
      return value
    }
  }

  function cloneRun(run: Run): Run {
    return {
      ...run,
      context: cloneValue(run.context),
      payload: cloneValue(run.payload),
      result: cloneValue(run.result),
      timeline: cloneValue(run.timeline),
      childRunIds: cloneValue(run.childRunIds),
    }
  }

  function create(
    processName: string,
    eventName: string,
    payload: unknown,
    parentRunId?: string | null,
    correlationId?: string,
    context?: Record<string, unknown>,
    depth?: number,
    idempotencyKey?: string | null,
  ): Run {
    const id = crypto.randomUUID()
    const now = Date.now()
    const contextCopy = context ? cloneValue(context) : {}
    const payloadCopy = cloneValue(payload)

    const run: Run = {
      id,
      correlationId: correlationId ?? id,
      processName,
      eventName,
      state: 'idle',
      context: contextCopy,
      payload: payloadCopy,
      result: null,
      timeline: [{ state: 'idle', timestamp: now, event: eventName, payload: payloadCopy }],
      parentRunId: parentRunId ?? null,
      childRunIds: [],
      startedAt: now,
      completedAt: null,
      depth: depth ?? 0,
      idempotencyKey: idempotencyKey ?? null,
      attempt: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      handlerVersion: null,
    }

    runs.set(id, run)

    if (parentRunId) {
      const parent = runs.get(parentRunId)
      if (parent) parent.childRunIds.push(id)
    }

    return cloneRun(run)
  }

  function transition(runId: string, state: ProcessState, meta?: { error?: string; event?: string; payload?: unknown }): Run {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)

    const allowed = VALID_TRANSITIONS[run.state]
    if (!allowed.includes(state)) {
      throw new Error(`Invalid transition: ${run.state} → ${state}`)
    }

    run.state = state
    run.leaseOwner = null
    run.leaseExpiresAt = null
    run.heartbeatAt = null

    const entry: TimelineEntry = { state, timestamp: Date.now() }
    if (meta?.error) entry.error = meta.error
    if (meta?.event) entry.event = meta.event
    if (meta?.payload !== undefined) entry.payload = cloneValue(meta.payload)

    run.timeline.push(entry)

    if (state === 'completed' || state === 'errored') {
      run.completedAt = Date.now()
    }

    return cloneRun(run)
  }

  function setResult(runId: string, result: HandlerResult): void {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    run.result = cloneValue(result)
  }

  function updateContext(runId: string, key: string, value: unknown): void {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    run.context[key] = cloneValue(value)
  }

  function prepareRetry(runId: string, retryAfter: number): void {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    run.attempt++
    run.retryAfter = retryAfter
  }

  function resetAttempt(runId: string): void {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    run.attempt = 0
    run.retryAfter = null
  }

  function claimIdle(limit: number, leaseOwner?: string, leaseDurationMs?: number): Run[] {
    const now = Date.now()
    const idle: Run[] = []
    for (const run of runs.values()) {
      if (run.state === 'idle' && (run.retryAfter === null || run.retryAfter <= now)) {
        idle.push(run)
        if (idle.length >= limit) break
      }
    }
    for (const run of idle) {
      transition(run.id, 'running')
      if (leaseOwner && leaseDurationMs) {
        const canonical = runs.get(run.id)!
        canonical.leaseOwner = leaseOwner
        canonical.leaseExpiresAt = Date.now() + leaseDurationMs
        canonical.heartbeatAt = Date.now()
      }
    }
    return idle.map(cloneRun)
  }

  function get(runId: string): Run | null {
    const run = runs.get(runId)
    return run ? cloneRun(run) : null
  }

  function getByProcess(processName: string): Run[] {
    return [...runs.values()].filter((r) => r.processName === processName).map(cloneRun)
  }

  function getByState(state: ProcessState): Run[] {
    return [...runs.values()].filter((r) => r.state === state).map(cloneRun)
  }

  function getAll(): Run[] {
    return [...runs.values()].map(cloneRun)
  }

  function getChain(runId: string): Run[] {
    const root = runs.get(runId)
    if (!root) return []

    const chain: Run[] = []
    const queue = [root]

    while (queue.length > 0) {
      const current = queue.shift()!
      chain.push(cloneRun(current))
      for (const childId of current.childRunIds) {
        const child = runs.get(childId)
        if (child) queue.push(child)
      }
    }

    return chain
  }

  function hasActiveRun(processName: string): boolean {
    for (const run of runs.values()) {
      if (run.processName === processName && (run.state === 'idle' || run.state === 'running')) {
        return true
      }
    }
    return false
  }

  function hasIdempotencyKey(key: string): boolean {
    for (const run of runs.values()) {
      if (run.idempotencyKey === key) return true
    }
    return false
  }

  function getByIdempotencyKey(key: string): Run[] {
    return [...runs.values()].filter((r) => r.idempotencyKey === key).map(cloneRun)
  }

  function heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): void {
    const run = runs.get(runId)
    if (!run) return
    if (run.state !== 'running' || run.leaseOwner !== leaseOwner) return
    run.leaseExpiresAt = leaseExpiresAt
    run.heartbeatAt = Date.now()
  }

  function reclaimStale(): Run[] {
    const now = Date.now()
    const reclaimed: Run[] = []
    for (const run of runs.values()) {
      if (run.state === 'running' && run.leaseExpiresAt !== null && run.leaseExpiresAt <= now) {
        run.state = 'idle'
        run.attempt++
        run.leaseOwner = null
        run.leaseExpiresAt = null
        run.heartbeatAt = null
        run.timeline.push({ state: 'idle', timestamp: now, error: 'lease expired' })
        reclaimed.push(cloneRun(run))
      }
    }
    return reclaimed
  }

  function setHandlerVersion(runId: string, version: string): void {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)
    run.handlerVersion = version
  }

  function countByState(state: ProcessState): number {
    let count = 0
    for (const run of runs.values()) {
      if (run.state === state) count++
    }
    return count
  }

  function hasState(state: ProcessState): boolean {
    for (const run of runs.values()) {
      if (run.state === state) return true
    }
    return false
  }

  function getByStatePaginated(state: ProcessState | null, limit: number, offset: number, opts?: { root?: boolean }): { runs: Run[]; total: number } {
    let filtered: Run[] = []
    for (const run of runs.values()) {
      if (state && run.state !== state) continue
      if (opts?.root && run.parentRunId !== null) continue
      filtered.push(run)
    }
    filtered.sort((a, b) => b.startedAt - a.startedAt)
    return { runs: filtered.slice(offset, offset + limit).map(cloneRun), total: filtered.length }
  }

  return {
    create,
    transition,
    setResult,
    updateContext,
    claimIdle,
    get,
    getByProcess,
    getByState,
    getAll,
    getChain,
    hasActiveRun,
    hasIdempotencyKey,
    getByIdempotencyKey,
    prepareRetry,
    resetAttempt,
    heartbeat,
    reclaimStale,
    setHandlerVersion,
    countByState,
    hasState,
    getByStatePaginated,
  }
}
