/**
 * String constants identifying specific engine error conditions.
 *
 * @example
 * ```ts
 * import { ErrorCode } from '@yella/engine'
 * if (err.code === ErrorCode.HANDLER_TIMEOUT) { ... }
 * ```
 */
export const ErrorCode = {
  /** Emitted payload exceeds {@link EngineOptions.maxPayloadBytes}. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** Event chain depth exceeds {@link EngineOptions.maxChainDepth}. */
  CHAIN_DEPTH_EXCEEDED: 'CHAIN_DEPTH_EXCEEDED',
  /** Handler execution exceeded {@link EngineOptions.handlerTimeoutMs}. */
  HANDLER_TIMEOUT: 'HANDLER_TIMEOUT',
  /** No process registered for the emitted event name. */
  HANDLER_NOT_FOUND: 'HANDLER_NOT_FOUND',
  /** Payload failed the process schema's `parse()` call. */
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  /** A process with the same name is already registered. */
  PROCESS_ALREADY_REGISTERED: 'PROCESS_ALREADY_REGISTERED',
  /** {@link Engine.drain} timed out waiting for runs to complete. */
  DRAIN_TIMEOUT: 'DRAIN_TIMEOUT',
  /** {@link Engine.stop} with `graceful: true` timed out. */
  GRACEFUL_STOP_TIMEOUT: 'GRACEFUL_STOP_TIMEOUT',
  /** A run's lease expired before it completed (crash recovery). */
  LEASE_EXPIRED: 'LEASE_EXPIRED',
} as const

/** Union of all error code string literals. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * Typed error thrown by the engine. The {@link code} field discriminates
 * the failure reason and is stable across versions.
 */
export class EngineError extends Error {
  constructor(
    /** Machine-readable error discriminator. */
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

/**
 * The possible states a run can occupy.
 *
 * `idle` → `running` → `completed` | `errored`
 *
 * Retries transition `running` → `idle`. Manual retry transitions `errored` → `idle`.
 */
export type ProcessState = 'idle' | 'running' | 'completed' | 'errored'

/**
 * Maps each {@link ProcessState} to the states it may legally transition to.
 * Used internally by the run store to enforce the state machine.
 */
export const VALID_TRANSITIONS: Record<ProcessState, ProcessState[]> = {
  idle: ['running', 'errored'],
  running: ['completed', 'errored', 'idle'],
  completed: [],
  errored: ['idle'],
}

/**
 * Configuration for automatic retries on handler failure.
 */
export type RetryPolicy = {
  /** Maximum number of retry attempts before the run is sent to the dead-letter state. */
  maxRetries: number
  /**
   * Delay in milliseconds before the next retry, or a function that receives the
   * current attempt number and returns the delay (for exponential backoff, etc.).
   */
  delay?: number | ((attempt: number) => number)
}

/**
 * A Zod-compatible schema used to validate event payloads before handler execution.
 * Any object with a `parse(data): T` method satisfies this contract.
 *
 * @typeParam T - The validated payload type returned by `parse`.
 */
export type Schema<T = unknown> = { parse(data: unknown): T }

/**
 * A single entry in a run's timeline, recording a state transition with metadata.
 */
export type TimelineEntry = {
  /** The state the run transitioned to. */
  state: ProcessState
  /** Unix epoch timestamp (ms) when the transition occurred. */
  timestamp: number
  /** Event name that triggered this transition, if applicable. */
  event?: string
  /** Payload associated with the transition, if applicable. */
  payload?: unknown
  /** Error message, if this transition was caused by a failure. */
  error?: string
}

/**
 * A run represents a single execution of a process handler in response to an event.
 * Runs track their full lifecycle from creation through completion or failure.
 */
export type Run = {
  /** Unique identifier for this run. */
  id: string
  /** Shared identifier linking all runs in the same causal chain. */
  correlationId: string
  /** Name of the registered process that owns this run. */
  processName: string
  /** The event name that triggered this run. */
  eventName: string
  /** Current lifecycle state of the run. */
  state: ProcessState
  /** Mutable key-value store scoped to the correlation chain. */
  context: Record<string, unknown>
  /** The event payload passed to the handler. */
  payload: unknown
  /** Handler result, or `null` if the run has not completed. */
  result: HandlerResult | null
  /** Ordered log of every state transition this run has undergone. */
  timeline: TimelineEntry[]
  /** ID of the run that triggered this one, or `null` for root runs. */
  parentRunId: string | null
  /** IDs of runs triggered by this run's handler via `triggerEvent`. */
  childRunIds: string[]
  /** Unix epoch timestamp (ms) when the run was created. */
  startedAt: number
  /** Unix epoch timestamp (ms) when the run reached a terminal state, or `null`. */
  completedAt: number | null
  /** Chain depth (0 for root runs, incremented for each chained event). */
  depth: number
  /** Idempotency key used to deduplicate this run, or `null`. */
  idempotencyKey: string | null
  /** Current retry attempt number (0 for the first execution). */
  attempt: number
  /** Unix epoch timestamp (ms) after which a retry may execute, or `null`. */
  retryAfter: number | null
  /** Identifier of the worker that currently holds the lease, or `null`. */
  leaseOwner: string | null
  /** Unix epoch timestamp (ms) when the current lease expires, or `null`. */
  leaseExpiresAt: number | null
  /** Unix epoch timestamp (ms) of the last heartbeat, or `null`. */
  heartbeatAt: number | null
  /** Version string of the handler that processed this run, or `null`. */
  handlerVersion: string | null
}

/**
 * The value returned by a process handler after execution.
 */
export type HandlerResult = {
  /** Whether the handler completed successfully. */
  success: boolean
  /** Optional result payload. */
  payload?: unknown
  /** Optional event name to emit as a chained event. */
  triggerEvent?: string
  /** Error message if the handler failed. */
  error?: string
  /** Structured error code if the handler failed. */
  errorCode?: ErrorCode
}

/**
 * Context object passed to every process handler during execution.
 * Provides access to the event data, run metadata, and side-effect APIs.
 *
 * @typeParam T - The validated payload type (inferred from schema if provided).
 */
export type HandlerContext<T = unknown> = {
  /** The event name that triggered this handler. */
  event: string
  /** The event payload (validated by schema if one was registered). */
  payload: T
  /** Unique identifier of the current run. */
  runId: string
  /** Correlation ID shared across the entire event chain. */
  correlationId: string
  /** Mutable key-value context shared across the correlation chain. */
  context: Record<string, unknown>
  /**
   * Set a key-value pair in the run's shared context.
   * @param key - The context key.
   * @param value - The value to store.
   */
  setContext(key: string, value: unknown): void
  /**
   * Execute a durable side effect. On first execution the function runs and the
   * result is persisted. On retry the stored result is replayed without re-executing,
   * providing effectively-once semantics.
   *
   * @typeParam R - The return type of the effect function.
   * @param effectKey - Unique key identifying this effect within the run.
   * @param fn - The function to execute (or replay).
   * @returns The effect's result.
   */
  effect<R>(effectKey: string, fn: () => Promise<R> | R): Promise<R>
}

/**
 * Function signature for the ergonomic effect API in {@link ProcessContext}.
 * Accepts a named `{ key, run }` object instead of positional arguments.
 * When `key` is a `string[]`, it is canonically encoded to avoid collision bugs.
 *
 * @example
 * ```ts
 * const charge = await ctx.effect({
 *   key: 'stripe-charge',
 *   run: () => stripe.charges.create({ amount: 1000 }),
 * })
 *
 * // Array keys for dynamic effect deduplication
 * const result = await ctx.effect({
 *   key: ['send-email', userId],
 *   run: () => sendEmail(userId),
 * })
 * ```
 */
export type EffectFn = <R>(opts: { key: string | string[]; run: () => Promise<R> | R }) => Promise<R>

/**
 * Ergonomic handler context passed to {@link ProcessDefinitionConfig.run}.
 * Wraps {@link HandlerContext} with named-parameter effect calls and
 * `ok()`/`fail()` helpers that eliminate return-object boilerplate.
 *
 * @example
 * ```ts
 * engine.process({
 *   name: 'charge',
 *   on: 'order:paid',
 *   run: async (ctx) => {
 *     const charge = await ctx.effect({
 *       key: 'stripe-charge',
 *       run: () => stripe.charges.create({ amount: ctx.payload.total }),
 *     })
 *     return ctx.ok({ chargeId: charge.id })
 *   },
 * })
 * ```
 */
export type ProcessContext<T = unknown> = {
  /** The event name that triggered this handler. */
  event: string
  /** The event payload (validated by schema if one was registered). */
  payload: T
  /** Unique identifier of the current run. */
  runId: string
  /** Correlation ID shared across the entire event chain. */
  correlationId: string
  /** Mutable key-value context shared across the correlation chain. */
  context: Record<string, unknown>
  /** Set a key-value pair in the run's shared context. */
  setContext(key: string, value: unknown): void
  /** Execute a durable side effect with named parameters. */
  effect: EffectFn
  /** Return a success result, optionally with a payload and/or a chained event. */
  ok<P>(payload?: P, opts?: { emit?: string }): HandlerResult
  /** Return a failure result with an error message and optional error code. */
  fail(error: string, code?: ErrorCode): HandlerResult
}

/**
 * Configuration object for {@link Engine.process}. Replaces positional
 * arguments with a single named config, making registrations easier to read.
 *
 * @example
 * ```ts
 * engine.process({
 *   name: 'send-welcome',
 *   on: 'user:signup',
 *   schema: z.object({ email: z.string(), name: z.string() }),
 *   retry: { maxRetries: 3, delay: 1000 },
 *   run: async (ctx) => {
 *     await ctx.effect({
 *       key: 'welcome-email',
 *       run: () => sendEmail(ctx.payload.email, `Welcome, ${ctx.payload.name}!`),
 *     })
 *     return ctx.ok()
 *   },
 * })
 * ```
 */
export type ProcessDefinitionConfig<T = unknown> = {
  /** Unique name identifying this process. */
  name: string
  /** The event name this process listens for. */
  on: string
  /** Optional schema to validate event payloads before execution. */
  schema?: Schema<T>
  /** Optional retry policy for automatic retries on failure. */
  retry?: RetryPolicy
  /** Optional version string for handler versioning and migration. */
  version?: string
  /** When true, only one run of this process may be active (idle or running) at a time. Additional events are silently dropped. @defaultValue false */
  singleton?: boolean
  /** The handler function executed when the event fires. */
  run: (ctx: ProcessContext<T>) => Promise<HandlerResult> | HandlerResult
}

/** The possible states of a durable effect: started, completed, or failed. */
export type EffectState = 'started' | 'completed' | 'failed'

/**
 * A persisted record of a durable side effect execution.
 */
export type EffectRecord = {
  /** The run this effect belongs to. */
  runId: string
  /** Unique key identifying this effect within its run. */
  effectKey: string
  /** Current state of the effect. */
  state: EffectState
  /** The stored return value of the effect function. */
  output: unknown
  /** Error message if the effect failed, or `null`. */
  error: string | null
  /** Unix epoch timestamp (ms) when the effect started. */
  startedAt: number
  /** Unix epoch timestamp (ms) when the effect completed, or `null`. */
  completedAt: number | null
}

/**
 * Storage backend for durable side effects. Tracks effect state to enable
 * replay on retry without re-executing the side-effect function.
 */
export type EffectStore = {
  /** Retrieve an effect record by run ID and effect key, or `null` if not found. */
  getEffect(runId: string, effectKey: string): EffectRecord | null
  /** Retrieve all effect records for a given run. */
  getEffects(runId: string): EffectRecord[]
  /** Mark an effect as started (first execution attempt). */
  markStarted(runId: string, effectKey: string): void
  /** Mark an effect as completed and persist its output. */
  markCompleted(runId: string, effectKey: string, output: unknown): void
  /** Mark an effect as failed and persist the error message. */
  markFailed(runId: string, effectKey: string, error: string): void
}

/**
 * A process handler function that receives a {@link HandlerContext} and returns
 * a {@link HandlerResult} (or a promise of one).
 */
export type Handler = (ctx: HandlerContext) => Promise<HandlerResult> | HandlerResult

/**
 * A complete process definition binding an event name to a handler with
 * optional schema validation, retry policy, and version tracking.
 */
export type ProcessDefinition = {
  /** Unique name identifying this process. */
  name: string
  /** The event name this process listens for. */
  eventName: string
  /** The handler function executed when the event fires. */
  handler: Handler
  /** Optional schema to validate event payloads before execution. */
  schema?: Schema
  /** Optional retry policy for automatic retries on failure. */
  retry?: RetryPolicy
  /** Optional version string for handler versioning and migration. */
  version?: string
  /** When true, only one run of this process may be active (idle or running) at a time. @defaultValue false */
  singleton?: boolean
}

/**
 * Storage backend for runs. Implementations must enforce the
 * {@link VALID_TRANSITIONS} state machine and provide atomic claim semantics.
 */
export type RunStore = {
  /** Create a new run in `idle` state for the given process and event. */
  create(
    processName: string,
    eventName: string,
    payload: unknown,
    parentRunId?: string | null,
    correlationId?: string,
    context?: Record<string, unknown>,
    depth?: number,
    idempotencyKey?: string | null,
  ): Run
  /** Transition a run to a new state, recording metadata in the timeline. */
  transition(runId: string, state: ProcessState, meta?: { error?: string; event?: string; payload?: unknown }): Run
  /** Set the handler result on a run. */
  setResult(runId: string, result: HandlerResult): void
  /** Update a single key in the run's shared context. */
  updateContext(runId: string, key: string, value: unknown): void
  /** Atomically claim up to `limit` idle runs for execution, optionally with lease metadata. */
  claimIdle(limit: number, leaseOwner?: string, leaseDurationMs?: number): Run[]
  /** Retrieve a run by ID, or `null` if not found. */
  get(runId: string): Run | null
  /** Retrieve all runs for a given process name. */
  getByProcess(processName: string): Run[]
  /** Retrieve all runs in a given state. */
  getByState(state: ProcessState): Run[]
  /** Retrieve all runs in the store. */
  getAll(): Run[]
  /** Retrieve the full causal chain of runs starting from a given run ID. */
  getChain(runId: string): Run[]
  /** Check whether a process has any active (non-terminal) runs. */
  hasActiveRun(processName: string): boolean
  /** Mark a run for retry with a delay. */
  prepareRetry(runId: string, retryAfter: number): void
  /** Reset the attempt counter on a run (used by {@link Engine.requeueDead}). */
  resetAttempt(runId: string): void
  /** Update the heartbeat and lease expiry for a running run. */
  heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): void
  /** Reclaim runs whose leases have expired (crash recovery). */
  reclaimStale(): Run[]
  /** Check whether an idempotency key has already been used. */
  hasIdempotencyKey(key: string): boolean
  /** Retrieve all runs with a given idempotency key. */
  getByIdempotencyKey(key: string): Run[]
  /** Set the handler version on a run. */
  setHandlerVersion?(runId: string, version: string): void
  /** Close the underlying storage connection, if applicable. */
  close?(): void
}

/**
 * Configuration options for {@link Engine | createEngine}.
 */
export type EngineOptions = {
  /** Storage backend: `'memory'` (default) or SQLite with a file path. */
  store?: 'memory' | { type: 'sqlite'; path: string }
  /** Maximum number of runs executed concurrently. @defaultValue 10 */
  concurrency?: number
  /** Maximum depth of chained event chains. @defaultValue 10 */
  maxChainDepth?: number
  /** Maximum payload size in bytes. @defaultValue 1048576 (1 MB) */
  maxPayloadBytes?: number
  /** Timeout in milliseconds for each handler execution. @defaultValue 30000 */
  handlerTimeoutMs?: number
  /** Default retry policy applied to all processes without an explicit policy. */
  retry?: RetryPolicy
  /** Called when a run is retried after failure. */
  onRetry?: (run: Run, error: string, attempt: number) => void
  /** Called when a run exhausts its retry budget and enters the dead-letter state. */
  onDead?: (run: Run, error: string) => void
  /** Called when a run transitions to `running`. */
  onRunStart?: (run: Run) => void
  /** Called when a run transitions to `completed`. */
  onRunFinish?: (run: Run) => void
  /** Called when a run transitions to `errored`. */
  onRunError?: (run: Run, error: string) => void
  /** Lease duration in milliseconds for crash recovery. @defaultValue 30000 */
  leaseTimeoutMs?: number
  /** Heartbeat interval in milliseconds (defaults to leaseTimeoutMs / 3). */
  heartbeatIntervalMs?: number
  /**
   * Called when an internal error is caught that would otherwise be silently swallowed.
   * The `context` string identifies the error site (e.g. `'fillSlots'`, `'heartbeat'`, `'onRunStart'`).
   */
  onInternalError?: (error: unknown, context: string) => void
  /** Start a dev dashboard HTTP server. The server holds the Node.js event loop open until stopped. */
  server?: DevServerOptions
}

/**
 * The engine instance returned by {@link createEngine}.
 *
 * The engine is an always-on runtime that processes events as long as the host
 * application is running. It does not exit on its own, call {@link stop} to
 * tear down timers and release resources. For script-style usage, use
 * {@link drain} followed by {@link stop} to wait for completion and then exit.
 */
export interface Engine {
  /**
   * Register a process handler for an event.
   * @param name - Unique process name.
   * @param eventName - The event to listen for.
   * @param handler - The handler function.
   * @param opts - Optional retry policy and version.
   */
  register(name: string, eventName: string, handler: Handler, opts?: { retry?: RetryPolicy; version?: string; singleton?: boolean }): void

  /**
   * Register a process handler with schema validation.
   * @typeParam T - The validated payload type.
   * @param name - Unique process name.
   * @param eventName - The event to listen for.
   * @param schema - Schema to validate payloads.
   * @param handler - The handler function receiving validated payloads.
   * @param opts - Optional retry policy, version, and singleton flag.
   */
  register<T>(
    name: string,
    eventName: string,
    schema: Schema<T>,
    handler: (ctx: HandlerContext<T>) => Promise<HandlerResult> | HandlerResult,
    opts?: { retry?: RetryPolicy; version?: string; singleton?: boolean },
  ): void

  /**
   * Register a process using a single config object with named parameters.
   * Sugar over {@link register}, both APIs coexist.
   *
   * @typeParam T - The validated payload type (inferred from schema if provided).
   * @param config - Process definition config with `name`, `on`, `run`, and optional `schema`/`retry`/`version`.
   */
  process<T = unknown>(config: ProcessDefinitionConfig<T>): void

  /**
   * Remove a registered process by name.
   * @param name - The process name to unregister.
   */
  unregister(name: string): void

  /**
   * Emit an event, creating runs for all registered processes.
   * @param eventName - The event name to emit.
   * @param payload - The event payload.
   * @param opts - Optional idempotency key.
   * @returns The created runs (empty if engine is stopped or no handlers match).
   */
  emit(eventName: string, payload: unknown, opts?: { idempotencyKey?: string }): Run[]

  /**
   * Shorthand for registering an anonymous process handler.
   * @param eventName - The event to listen for.
   * @param handler - The handler function.
   * @returns The auto-generated process name.
   */
  on(eventName: string, handler: Handler): string

  /**
   * Register multiple process definitions at once.
   * @param defs - Array of process definitions.
   */
  registerMany(defs: { name: string; event: string; handler: Handler; schema?: Schema; retry?: RetryPolicy }[]): void

  /**
   * Emit an event and wait for all resulting runs to complete.
   * @param eventName - The event name to emit.
   * @param payload - The event payload.
   * @param opts - Optional idempotency key and timeout.
   * @returns The completed runs with final state.
   */
  emitAndWait(eventName: string, payload: unknown, opts?: { idempotencyKey?: string; timeoutMs?: number }): Promise<Run[]>

  /**
   * Get all runs currently in `running` state.
   * @returns Array of running runs.
   */
  getRunning(): Run[]

  /**
   * Get all runs in `completed` state.
   * @returns Array of completed runs.
   */
  getCompleted(): Run[]

  /**
   * Get all runs in `errored` state.
   * @returns Array of errored runs.
   */
  getErrored(): Run[]

  /**
   * Get all runs in `idle` state (queued, awaiting execution).
   * @returns Array of idle runs.
   */
  getIdle(): Run[]

  /**
   * Retrieve a specific run by its ID.
   * @param id - The run ID.
   * @returns The run, or `null` if not found.
   */
  getRun(id: string): Run | null

  /**
   * Retrieve the full causal chain of runs linked by parent/child relationships.
   * @param runId - Any run ID in the chain.
   * @returns All runs in the chain, ordered by creation.
   */
  getChain(runId: string): Run[]

  /**
   * Get all registered process definitions.
   * @returns Array of process definitions.
   */
  getProcesses(): ProcessDefinition[]

  /**
   * Retrieve all durable effect records for a given run.
   * @param runId - The run's ID.
   * @returns Array of effect records (empty if none).
   */
  getEffects(runId: string): EffectRecord[]

  /**
   * Retry an errored run. Resets it to idle state for re-execution.
   * @param runId - The errored run's ID.
   * @returns The updated run in idle state.
   * @throws If the run is not found or not in errored state.
   */
  retryRun(runId: string): Run

  /**
   * Requeue a dead-letter run by resetting its attempt counter and state.
   * Unlike {@link retryRun}, this resets the attempt count so the full
   * retry budget is available again.
   * @param runId - The errored run's ID.
   * @returns The updated run in idle state.
   * @throws If the run is not found or not in errored state.
   */
  requeueDead(runId: string): Run

  /**
   * Cancel an idle or running run, moving it to errored state.
   * @param runId - The run's ID.
   * @returns The cancelled run.
   * @throws If the run is not found or already in a terminal state.
   */
  cancelRun(runId: string): Run

  /**
   * Stop the engine and tear down all internal timers (dispatcher, heartbeat, lease loop).
   * No new events will be accepted after calling this. If a dev server is running, it is
   * also closed. Once stopped, the engine no longer holds the Node.js event loop open.
   * @param opts - Optional graceful shutdown: `{ graceful: true }` waits for in-flight
   *   handlers to finish before stopping. `timeoutMs` caps the wait (default: no limit).
   */
  stop(opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>

  /**
   * Wait for all idle and running runs to complete. This is the primary mechanism
   * for script-style usage where you emit events and want to block until all
   * resulting work (including chained events) finishes before exiting.
   * @param timeoutMs - Maximum time to wait in milliseconds.
   * @throws {@link EngineError} with code {@link ErrorCode.DRAIN_TIMEOUT} if runs don't finish in time.
   */
  drain(timeoutMs?: number): Promise<void>

  /**
   * Get the dev server handle. Returns `null` if no `server` option was
   * provided to {@link createEngine}. The promise resolves once the port
   * is bound. Uses dynamic import so users without `server` pay zero cost.
   */
  getServer(): Promise<DevServer> | null
}

/**
 * Options for the dev dashboard server in {@link EngineOptions.server}.
 */
export type DevServerOptions = {
  /** Host to bind to. @defaultValue '127.0.0.1' */
  host?: string
  /** Port to bind to. Use `0` for OS-assigned. @defaultValue 3000 */
  port?: number
}

/**
 * Handle returned by {@link Engine.getServer}.
 */
export type DevServer = {
  /** The resolved host and port the server is listening on. */
  address: { host: string; port: number }
  /** The Hono app instance, exposed for adding custom routes. */
  app: import('hono').Hono
  /** Stop the dev server. */
  stop(): Promise<void>
}
