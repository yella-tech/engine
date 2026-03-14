import type { Registry } from './registry.js'
import { EngineError, ErrorCode } from './types.js'
import type { EffectStore, EngineEvent, HandlerContext, HandlerResult, ProcessDefinition, RetryPolicy, Run, RunStore } from './types.js'

type AbortKind = 'cancel' | 'lease' | 'stop' | 'timeout'

class RunAbortError extends Error {
  constructor(
    public readonly kind: AbortKind,
    message: string,
    public readonly code?: ErrorCode,
  ) {
    super(message)
  }
}

export type BusOptions = {
  maxChainDepth: number
  maxPayloadBytes: number
  handlerTimeoutMs: number
  leaseOwner?: string
  effectStore?: EffectStore
  defaultRetry?: RetryPolicy
  emitEvent: (event: EngineEvent) => void
}

export function createBus(registry: Registry, runStore: RunStore, opts: BusOptions) {
  const executionControllers = new Map<string, AbortController>()

  function checkPayloadSize(payload: unknown) {
    if (payload !== undefined) {
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized, 'utf8') > opts.maxPayloadBytes) {
        throw new EngineError(ErrorCode.PAYLOAD_TOO_LARGE, 'payload exceeds max size')
      }
    }
  }

  function enqueue(eventName: string, payload: unknown, parentRunId?: string | null, correlationId?: string, parentContext?: Record<string, unknown>, idempotencyKey?: string): Run[] {
    checkPayloadSize(payload)

    let parentDepth = -1
    if (parentRunId) {
      const parent = runStore.get(parentRunId)
      if (parent) {
        parentDepth = parent.depth
        if (parentDepth + 1 > opts.maxChainDepth) {
          if (parent.state === 'running') {
            runStore.setResult(parentRunId, { success: false, error: 'max chain depth exceeded', errorCode: ErrorCode.CHAIN_DEPTH_EXCEEDED })
            runStore.transition(parentRunId, 'errored', { error: 'max chain depth exceeded' })
          }
          return []
        }
      }
    }

    const definitions = registry.getByEvent(eventName)
    if (definitions.length === 0) return []

    const childDepth = parentDepth + 1
    return runStore.createMany(
      definitions.map((def) => ({
        processName: def.name,
        eventName,
        payload,
        parentRunId,
        correlationId,
        context: parentContext,
        depth: childDepth,
        idempotencyKey: idempotencyKey ?? null,
        singleton: def.singleton === true,
      })),
    )
  }

  function resolveHandler(run: Run): ProcessDefinition | null {
    const def = registry.getByEvent(run.eventName).find((d) => d.name === run.processName)
    if (!def) {
      const error = `No handler found: ${run.processName}`
      runStore.setResult(run.id, { success: false, error, errorCode: ErrorCode.HANDLER_NOT_FOUND })
      runStore.transition(run.id, 'errored', { error })
      opts.emitEvent({ type: 'run:error', run: runStore.get(run.id)!, error, durationMs: 0 })
      return null
    }
    if (def.version) {
      runStore.setHandlerVersion?.(run.id, def.version)
    }
    return def
  }

  function validateSchema(run: Run, def: ProcessDefinition): { ok: true; payload: unknown } | { ok: false } {
    if (!def.schema) return { ok: true, payload: run.payload }
    try {
      return { ok: true, payload: def.schema.parse(run.payload) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      runStore.setResult(run.id, { success: false, error, errorCode: ErrorCode.SCHEMA_VALIDATION_FAILED })
      runStore.transition(run.id, 'errored', { error })
      opts.emitEvent({ type: 'run:error', run: runStore.get(run.id)!, error, durationMs: 0 })
      return { ok: false }
    }
  }

  function abortedReason(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason
    return new RunAbortError('stop', 'run aborted')
  }

  function buildContext(run: Run, handlerPayload: unknown, signal: AbortSignal): HandlerContext {
    const freshRun = runStore.get(run.id)!
    const runContext = structuredClone(freshRun.context)

    function ensureActive(): void {
      if (signal.aborted) throw abortedReason(signal)
      const current = runStore.get(run.id)
      if (!current || current.state !== 'running') {
        throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Run is no longer running: ${run.id}`)
      }
      if (opts.leaseOwner && current.leaseOwner !== opts.leaseOwner) {
        throw new RunAbortError('lease', `Run lease lost: ${run.id}`)
      }
    }

    return {
      event: run.eventName,
      payload: handlerPayload,
      runId: run.id,
      correlationId: run.correlationId,
      signal,
      context: runContext,
      setContext(key, value) {
        ensureActive()
        runContext[key] = value
        runStore.updateContext(run.id, key, value)
      },
      async effect<R>(effectKey: string, fn: () => Promise<R> | R): Promise<R> {
        ensureActive()

        if (!opts.effectStore) return Promise.resolve(fn()) as Promise<R>

        const existing = opts.effectStore.getEffect(run.id, effectKey)
        if (existing && existing.state === 'completed') {
          opts.emitEvent({ type: 'effect:replay', runId: run.id, effectKey })
          return existing.output as R
        }
        if (existing && existing.state === 'started') {
          throw new EngineError(ErrorCode.INVALID_RUN_STATE, `Effect already in progress: ${effectKey}`)
        }

        opts.effectStore.markStarted(run.id, effectKey)
        const effectStart = Date.now()
        try {
          const result = await fn()
          ensureActive()
          opts.effectStore.markCompleted(run.id, effectKey, result)
          opts.emitEvent({ type: 'effect:complete', runId: run.id, effectKey, durationMs: Date.now() - effectStart })
          return result
        } catch (err) {
          if (signal.aborted) throw abortedReason(signal)
          const error = err instanceof Error ? err.message : String(err)
          opts.effectStore.markFailed(run.id, effectKey, error)
          opts.emitEvent({ type: 'effect:error', runId: run.id, effectKey, error, durationMs: Date.now() - effectStart })
          throw err
        }
      },
    }
  }

  async function invokeHandler(def: ProcessDefinition, ctx: HandlerContext, controller: AbortController) {
    const handlerPromise = Promise.resolve(def.handler(ctx))

    let onAbort: (() => void) | undefined
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortedReason(controller.signal))
      if (controller.signal.aborted) {
        onAbort()
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true })
      }
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const raceEntries: Array<Promise<HandlerResult> | Promise<never>> = [handlerPromise, abortPromise]
    if (opts.handlerTimeoutMs > 0 && opts.handlerTimeoutMs < Infinity) {
      raceEntries.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeoutError = new RunAbortError('timeout', 'handler timed out', ErrorCode.HANDLER_TIMEOUT)
            controller.abort(timeoutError)
            reject(timeoutError)
          }, opts.handlerTimeoutMs)
        }),
      )
    }

    try {
      return await Promise.race(raceEntries)
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }

  function finalizeSuccess(run: Run, result: HandlerResult, durationMs: number) {
    runStore.setResult(run.id, result)
    runStore.transition(run.id, result.success ? 'completed' : 'errored', {
      error: result.error,
    })

    const finished = runStore.get(run.id)!
    if (result.success) {
      opts.emitEvent({ type: 'run:complete', run: finished, durationMs })
    } else {
      opts.emitEvent({ type: 'run:error', run: finished, error: result.error ?? 'unknown', durationMs })
    }
  }

  function finalizeError(run: Run, err: unknown, def: ProcessDefinition, durationMs: number) {
    try {
      const current = runStore.get(run.id)
      if (!current || current.state !== 'running') return
      if (opts.leaseOwner && current.leaseOwner !== opts.leaseOwner) return

      const error = err instanceof Error ? err.message : String(err)
      const errorCode = err instanceof EngineError ? err.code : err instanceof RunAbortError ? err.code : undefined
      const retryPolicy = def.retry ?? opts.defaultRetry
      const attempt = current!.attempt

      if (retryPolicy && attempt < retryPolicy.maxRetries) {
        const delaySpec = retryPolicy.delay ?? 1000
        const delayMs = typeof delaySpec === 'function' ? delaySpec(attempt) : delaySpec
        runStore.prepareRetry(run.id, Date.now() + delayMs)
        runStore.transition(run.id, 'idle', { error })
        opts.emitEvent({ type: 'run:retry', run: runStore.get(run.id)!, error, attempt })
      } else {
        runStore.setResult(run.id, { success: false, error, errorCode })
        runStore.transition(run.id, 'errored', { error, event: retryPolicy ? 'dead-letter' : undefined })
        const errored = runStore.get(run.id)!
        if (retryPolicy) opts.emitEvent({ type: 'run:dead', run: errored, error })
        opts.emitEvent({ type: 'run:error', run: errored, error, durationMs })
      }
    } catch (err) {
      opts.emitEvent({ type: 'internal:error', error: err, context: 'finalizeError' })
    }
  }

  async function executeRun(run: Run): Promise<void> {
    const def = resolveHandler(run)
    if (!def) return

    const validated = validateSchema(run, def)
    if (!validated.ok) return

    const controller = new AbortController()
    executionControllers.set(run.id, controller)

    const startTime = Date.now()
    try {
      opts.emitEvent({ type: 'run:start', run })
      const ctx = buildContext(run, validated.payload, controller.signal)
      const result = await invokeHandler(def, ctx, controller)
      const durationMs = Date.now() - startTime

      const current = runStore.get(run.id)
      if (!current || current.state !== 'running') return
      if (opts.leaseOwner && current.leaseOwner !== opts.leaseOwner) return

      if (result.success && result.triggerEvent && !result.deferred) {
        const childRuns = enqueue(result.triggerEvent, result.payload, run.id, run.correlationId, current.context)
        const currentAfterEnqueue = runStore.get(run.id)
        if (!currentAfterEnqueue || currentAfterEnqueue.state !== 'running') return
        if (childRuns.length === 0) {
          const error = `Trigger event was not admitted: ${result.triggerEvent}`
          runStore.setResult(run.id, { success: false, error, errorCode: ErrorCode.INVALID_RUN_STATE })
          runStore.transition(run.id, 'errored', { error, event: 'child-admission-failed' })
          opts.emitEvent({ type: 'run:error', run: runStore.get(run.id)!, error, durationMs })
          return
        }
      }

      checkPayloadSize(result.payload)
      finalizeSuccess(run, result, durationMs)
    } catch (err) {
      const durationMs = Date.now() - startTime
      if (err instanceof RunAbortError) {
        if (err.kind === 'cancel' || err.kind === 'lease') {
          return
        }
        if (err.kind === 'stop') {
          const current = runStore.get(run.id)
          if (!current || current.state !== 'running') return
          if (opts.leaseOwner && current.leaseOwner !== opts.leaseOwner) return
          runStore.transition(run.id, 'idle', { error: err.message })
          return
        }
      }
      finalizeError(run, err, def, durationMs)
    } finally {
      executionControllers.delete(run.id)
    }
  }

  function abortRun(runId: string, kind: AbortKind, message: string): void {
    const controller = executionControllers.get(runId)
    if (!controller || controller.signal.aborted) return
    controller.abort(new RunAbortError(kind, message, kind === 'timeout' ? ErrorCode.HANDLER_TIMEOUT : undefined))
  }

  function abortAll(kind: Exclude<AbortKind, 'timeout'>, message: string): void {
    for (const runId of executionControllers.keys()) {
      abortRun(runId, kind, message)
    }
  }

  return { enqueue, executeRun, abortRun, abortAll }
}

export type Bus = ReturnType<typeof createBus>
