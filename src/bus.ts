import type { Registry } from './registry.js'
import { EngineError, ErrorCode } from './types.js'
import type { EffectStore, EngineEvent, HandlerContext, HandlerResult, ProcessDefinition, RetryPolicy, Run, RunStore } from './types.js'

export type BusOptions = {
  maxChainDepth: number
  maxPayloadBytes: number
  handlerTimeoutMs: number
  effectStore?: EffectStore
  defaultRetry?: RetryPolicy
  emitEvent: (event: EngineEvent) => void
}

export function createBus(registry: Registry, runStore: RunStore, opts: BusOptions) {
  function checkPayloadSize(payload: unknown) {
    if (payload !== undefined) {
      const serialized = JSON.stringify(payload)
      if (Buffer.byteLength(serialized, 'utf8') > opts.maxPayloadBytes) {
        throw new EngineError(ErrorCode.PAYLOAD_TOO_LARGE, 'payload exceeds max size')
      }
    }
  }

  function enqueue(eventName: string, payload: unknown, parentRunId?: string | null, correlationId?: string, parentContext?: Record<string, unknown>, idempotencyKey?: string): Run[] {
    // Idempotency key check: no new runs created for duplicate key
    if (idempotencyKey && runStore.hasIdempotencyKey(idempotencyKey)) {
      return []
    }

    checkPayloadSize(payload)

    // Chain depth check
    let parentDepth = -1
    if (parentRunId) {
      const parent = runStore.get(parentRunId)
      if (parent) {
        parentDepth = parent.depth
        if (parentDepth + 1 > opts.maxChainDepth) {
          // Only error the parent if it's still running (not already completed)
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
    const runs: Run[] = []
    for (const def of definitions) {
      if (def.singleton && runStore.hasActiveRun(def.name)) continue

      try {
        const run = runStore.create(def.name, eventName, payload, parentRunId, correlationId, parentContext, childDepth, idempotencyKey ?? null)
        runs.push(run)
      } catch (err) {
        // Cross-process race: another process already created a run with this idempotency key.
        // The UNIQUE constraint on (idempotency_key, process_name) caught it.
        if (idempotencyKey && err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
          return []
        }
        throw err
      }
    }
    return runs
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

  function buildContext(run: Run, handlerPayload: unknown): HandlerContext {
    const freshRun = runStore.get(run.id)!
    const runContext = structuredClone(freshRun.context)

    return {
      event: run.eventName,
      payload: handlerPayload,
      runId: run.id,
      correlationId: run.correlationId,
      context: runContext,
      setContext(key, value) {
        runContext[key] = value
        runStore.updateContext(run.id, key, value)
      },
      async effect<R>(effectKey: string, fn: () => Promise<R> | R): Promise<R> {
        if (!opts.effectStore) return fn() as Promise<R>

        const existing = opts.effectStore.getEffect(run.id, effectKey)
        if (existing && existing.state === 'completed') {
          opts.emitEvent({ type: 'effect:replay', runId: run.id, effectKey })
          return existing.output as R
        }

        // started or no record, (re-)execute
        opts.effectStore.markStarted(run.id, effectKey)
        const effectStart = Date.now()
        try {
          const result = await fn()
          opts.effectStore.markCompleted(run.id, effectKey, result)
          opts.emitEvent({ type: 'effect:complete', runId: run.id, effectKey, durationMs: Date.now() - effectStart })
          return result
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          opts.effectStore.markFailed(run.id, effectKey, error)
          opts.emitEvent({ type: 'effect:error', runId: run.id, effectKey, error, durationMs: Date.now() - effectStart })
          throw err
        }
      },
    }
  }

  async function invokeHandler(def: ProcessDefinition, ctx: HandlerContext) {
    if (opts.handlerTimeoutMs > 0 && opts.handlerTimeoutMs < Infinity) {
      let timer: ReturnType<typeof setTimeout>
      return Promise.race([
        Promise.resolve(def.handler(ctx)).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EngineError(ErrorCode.HANDLER_TIMEOUT, 'handler timed out')), opts.handlerTimeoutMs)
        }),
      ])
    }
    return def.handler(ctx)
  }

  function finalizeSuccess(run: Run, result: HandlerResult, context: Record<string, unknown>, durationMs: number) {
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

    if (result.success && result.triggerEvent && !result.deferred) {
      enqueue(result.triggerEvent, result.payload, run.id, run.correlationId, context)
    }
  }

  function finalizeError(run: Run, err: unknown, def: ProcessDefinition, durationMs: number) {
    try {
      const current = runStore.get(run.id)
      if (current && current.state !== 'running') return

      const error = err instanceof Error ? err.message : String(err)
      const errorCode = err instanceof EngineError ? err.code : undefined
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
        runStore.transition(run.id, 'errored', { error })
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

    const startTime = Date.now()
    try {
      opts.emitEvent({ type: 'run:start', run })
      const ctx = buildContext(run, validated.payload)
      const result = await invokeHandler(def, ctx)
      const durationMs = Date.now() - startTime

      // Guard: if timeout already errored this run, bail
      const current = runStore.get(run.id)
      if (current && current.state !== 'running') return

      checkPayloadSize(result.payload)
      finalizeSuccess(run, result, ctx.context, durationMs)
    } catch (err) {
      const durationMs = Date.now() - startTime
      finalizeError(run, err, def, durationMs)
    }
  }

  return { enqueue, executeRun }
}

export type Bus = ReturnType<typeof createBus>
