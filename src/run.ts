import crypto from 'node:crypto'
import { getRunStatus, isDeferredRun } from './status.js'
import type { HandlerResult, ProcessState, Run, RunCreateRequest, RunQueryOptions, RunStatus, RunStore, TimelineEntry } from './types.js'
import { VALID_TRANSITIONS } from './types.js'

export function createRunStore(): RunStore {
  const runs = new Map<string, Run>()
  const emissionReservations = new Set<string>()
  const activeSingletons = new Map<string, string>()
  const singletonRunProcesses = new Map<string, string>()

  function cloneValue<T>(value: T): T {
    try {
      return structuredClone(value)
    } catch {
      throw new Error('Value could not be cloned')
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

  function emissionReservationKey(eventName: string, idempotencyKey: string): string {
    return `${eventName}\u0000${idempotencyKey}`
  }

  function syncSingletonForStateChange(run: Run, nextState: ProcessState): void {
    const processName = singletonRunProcesses.get(run.id)
    if (!processName) return

    const wasActive = run.state === 'idle' || run.state === 'running'
    const willBeActive = nextState === 'idle' || nextState === 'running'

    if (!wasActive && willBeActive) {
      const owner = activeSingletons.get(processName)
      if (owner && owner !== run.id) {
        throw new Error(`Singleton already active: ${processName}`)
      }
      activeSingletons.set(processName, run.id)
      return
    }

    if (wasActive && !willBeActive && activeSingletons.get(processName) === run.id) {
      activeSingletons.delete(processName)
    }
  }

  function createStoredRun(id: string, request: RunCreateRequest): Run {
    const now = Date.now()
    const contextCopy = request.context ? cloneValue(request.context) : {}
    const payloadCopy = cloneValue(request.payload)

    const run: Run = {
      id,
      correlationId: request.correlationId ?? id,
      processName: request.processName,
      eventName: request.eventName,
      state: 'idle',
      context: contextCopy,
      payload: payloadCopy,
      result: null,
      timeline: [{ state: 'idle', timestamp: now, event: request.eventName, payload: payloadCopy }],
      parentRunId: request.parentRunId ?? null,
      childRunIds: [],
      startedAt: now,
      completedAt: null,
      depth: request.depth ?? 0,
      idempotencyKey: request.idempotencyKey ?? null,
      attempt: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      handlerVersion: null,
    }

    runs.set(id, run)

    if (request.parentRunId) {
      const parent = runs.get(request.parentRunId)
      if (parent) parent.childRunIds.push(id)
    }

    return run
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
    const run = createStoredRun(crypto.randomUUID(), {
      processName,
      eventName,
      payload,
      parentRunId,
      correlationId,
      context,
      depth,
      idempotencyKey,
    })

    return cloneRun(run)
  }

  function createMany(requests: RunCreateRequest[]): Run[] {
    if (requests.length === 0) return []

    const eventName = requests[0].eventName
    const idempotencyKey = requests[0].idempotencyKey ?? null
    const reservationKey = idempotencyKey ? emissionReservationKey(eventName, idempotencyKey) : null
    if (reservationKey && emissionReservations.has(reservationKey)) {
      return []
    }

    const creatable: Array<{ id: string; request: RunCreateRequest }> = []
    for (const request of requests) {
      if (request.singleton && activeSingletons.has(request.processName)) {
        continue
      }
      creatable.push({ id: crypto.randomUUID(), request })
    }

    if (creatable.length === 0) return []

    const createdIds: string[] = []
    const reservedSingletons: Array<{ processName: string; runId: string }> = []
    const parentSnapshots = new Map<string, string[]>()
    let reservedEmission = false

    try {
      if (reservationKey) {
        emissionReservations.add(reservationKey)
        reservedEmission = true
      }

      for (const { id, request } of creatable) {
        if (request.singleton) {
          activeSingletons.set(request.processName, id)
          singletonRunProcesses.set(id, request.processName)
          reservedSingletons.push({ processName: request.processName, runId: id })
        }
        if (request.parentRunId && !parentSnapshots.has(request.parentRunId)) {
          parentSnapshots.set(request.parentRunId, [...(runs.get(request.parentRunId)?.childRunIds ?? [])])
        }
        createStoredRun(id, request)
        createdIds.push(id)
      }

      return createdIds.map((id) => cloneRun(runs.get(id)!))
    } catch (err) {
      for (const id of createdIds) {
        runs.delete(id)
      }
      for (const [parentId, childIds] of parentSnapshots) {
        const parent = runs.get(parentId)
        if (parent) parent.childRunIds = childIds
      }
      for (const { processName, runId } of reservedSingletons) {
        if (activeSingletons.get(processName) === runId) {
          activeSingletons.delete(processName)
        }
        singletonRunProcesses.delete(runId)
      }
      if (reservedEmission && reservationKey) {
        emissionReservations.delete(reservationKey)
      }
      throw err
    }
  }

  function transition(runId: string, state: ProcessState, meta?: { error?: string; event?: string; payload?: unknown }): Run {
    const run = runs.get(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)

    const allowed = VALID_TRANSITIONS[run.state]
    if (!allowed.includes(state)) {
      throw new Error(`Invalid transition: ${run.state} → ${state}`)
    }

    syncSingletonForStateChange(run, state)
    run.state = state
    run.leaseOwner = null
    run.leaseExpiresAt = null
    run.heartbeatAt = null
    if (state === 'idle' || state === 'running') {
      run.result = null
      run.completedAt = null
    }

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

  function heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): boolean {
    const run = runs.get(runId)
    if (!run) return false
    if (run.state !== 'running' || run.leaseOwner !== leaseOwner) return false
    run.leaseExpiresAt = leaseExpiresAt
    run.heartbeatAt = Date.now()
    return true
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

  function paginateRuns(list: Run[], limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    const order = opts?.order ?? 'desc'
    let filtered = opts?.root ? list.filter((run) => run.parentRunId === null) : list
    if (opts?.eventName) {
      const eventName = opts.eventName
      filtered = filtered.filter((run) => run.eventName === eventName)
    }
    filtered.sort((a, b) => (order === 'asc' ? a.startedAt - b.startedAt : b.startedAt - a.startedAt))
    return {
      runs: filtered.slice(offset, offset + limit).map(cloneRun),
      total: filtered.length,
    }
  }

  function getByStatePaginated(state: ProcessState | null, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    let filtered: Run[] = []
    for (const run of runs.values()) {
      if (state && run.state !== state) continue
      filtered.push(run)
    }
    return paginateRuns(filtered, limit, offset, opts)
  }

  function getByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number } {
    const filtered: Run[] = []
    for (const run of runs.values()) {
      if (getRunStatus(run) !== status) continue
      filtered.push(run)
    }
    return paginateRuns(filtered, limit, offset, opts)
  }

  function pruneCompletedBefore(cutoffMs: number): string[] {
    const prunedIds = new Set<string>()
    for (const [id, run] of runs.entries()) {
      if (run.state !== 'completed' || run.completedAt === null || run.completedAt >= cutoffMs || isDeferredRun(run)) {
        continue
      }
      if (run.childRunIds.some((childId) => runs.has(childId))) {
        continue
      }
      prunedIds.add(id)
    }

    if (prunedIds.size === 0) return []

    const impactedParentIds = new Set<string>()
    for (const id of prunedIds) {
      const run = runs.get(id)
      if (run?.parentRunId) impactedParentIds.add(run.parentRunId)
    }

    for (const id of prunedIds) {
      const singletonProcess = singletonRunProcesses.get(id)
      if (singletonProcess && activeSingletons.get(singletonProcess) === id) {
        activeSingletons.delete(singletonProcess)
      }
      singletonRunProcesses.delete(id)
      runs.delete(id)
    }

    for (const parentId of impactedParentIds) {
      const parent = runs.get(parentId)
      if (!parent) continue
      parent.childRunIds = parent.childRunIds.filter((childId) => !prunedIds.has(childId))
    }

    for (const run of runs.values()) {
      if (run.parentRunId && prunedIds.has(run.parentRunId)) {
        run.parentRunId = null
      }
    }

    return Array.from(prunedIds)
  }

  return {
    create,
    createMany,
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
    getByStatusPaginated,
    pruneCompletedBefore,
  }
}
