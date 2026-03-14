/**
 * String constants identifying specific engine error conditions.
 *
 * @example
 * ```ts
 * import { ErrorCode } from '@yellatech/engine'
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
  /** A run was not found by ID. */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  /** An operation was attempted on a run in an invalid state. */
  INVALID_RUN_STATE: 'INVALID_RUN_STATE',
  /** An engine configuration option has an invalid value. */
  INVALID_CONFIG: 'INVALID_CONFIG',
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
 * Operator-facing run classification exposed by the API/UI layer.
 *
 * This intentionally extends the raw engine lifecycle with derived statuses
 * like `deferred` and `dead-letter` while preserving the persisted core state machine.
 */
export type RunStatus = ProcessState | 'deferred' | 'dead-letter'

/** Sort order for run list queries. */
export type RunSortOrder = 'asc' | 'desc'

/** Shared options for paginated run queries. */
export type RunQueryOptions = {
  /** Restrict results to root runs only. */
  root?: boolean
  /** Order by `startedAt`. Defaults to `'desc'`. */
  order?: RunSortOrder
}

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
  /** Maximum number of retry attempts before the run is marked with dead-letter status. Must be >= 0. */
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
  /** Event-scoped idempotency key used to deduplicate the originating emission, or `null`. */
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
  /** Optional event name to emit as a chained event. When `deferred` is true, the event is stored but not emitted until `engine.resume(runId)` is called. */
  triggerEvent?: string
  /**
   * When true, `triggerEvent` is stored on the completed run but not emitted.
   * Call `engine.resume(runId)` later to continue the chain. This enables
   * human-in-the-loop workflows where a pipeline pauses for external approval.
   *
   * @defaultValue false
   *
   * @example
   * ```ts
   * // Handler defers the next step
   * engine.register('validate', 'order:new', async (ctx) => ({
   *   success: true,
   *   triggerEvent: 'order:approved',
   *   deferred: true,
   *   payload: { orderId: ctx.payload.orderId },
   * }))
   *
   * // Later, after approval:
   * engine.resume(runId) // emits 'order:approved', continuing the chain
   * ```
   */
  deferred?: boolean
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
  /** Abort signal for cooperative cancellation, shutdown, and timeout handling. */
  signal: AbortSignal
  /**
   * Mutable key-value context shared across the correlation chain.
   * Deep-copied via `structuredClone` on each handler invocation, direct mutations
   * to nested objects will not persist. Values stored here must be
   * `structuredClone`-compatible. Use {@link setContext} to persist changes.
   */
  context: Record<string, unknown>
  /**
   * Set a key-value pair in the run's shared context.
   * @param key - The context key.
   * @param value - The value to store. Must be `structuredClone`-compatible.
   */
  setContext(key: string, value: unknown): void
  /**
   * Execute a durable side effect. On first execution the function runs and the
   * result is persisted. On retry a completed result is replayed without
   * re-executing. If recovery finds the effect still in `started`, the engine
   * fences the call and throws instead of running the side effect body again.
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
  /** Abort signal for cooperative cancellation, shutdown, and timeout handling. */
  signal: AbortSignal
  /**
   * Mutable key-value context shared across the correlation chain.
   * Deep-copied via `structuredClone` on each handler invocation, direct mutations
   * to nested objects will not persist. Values stored here must be
   * `structuredClone`-compatible. Use {@link setContext} to persist changes.
   */
  context: Record<string, unknown>
  /** Set a key-value pair in the run's shared context. Values must be `structuredClone`-compatible. */
  setContext(key: string, value: unknown): void
  /** Execute a durable side effect with named parameters. Completed effects replay; in-progress effects are fenced. */
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
  /** When true, only one run of this process may be active (idle or running) at a time. Admission is enforced atomically by the store and additional matching events are dropped. @defaultValue false */
  singleton?: boolean
  /**
   * Event names this process may emit via `triggerEvent` in the handler result.
   * Used to build the static event flow graph returned by {@link Engine.getGraph}.
   *
   * @example
   * ```ts
   * engine.process({
   *   name: 'validate',
   *   on: 'order:new',
   *   emits: ['order:validated', 'order:rejected'],
   *   run: async (ctx) => {
   *     const valid = await validate(ctx.payload)
   *     return ctx.ok(ctx.payload, { emit: valid ? 'order:validated' : 'order:rejected' })
   *   },
   * })
   * ```
   */
  emits?: string[]
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
  /** Clear any in-progress (`started`) effects for a run so operators can repair and retry it. Returns the number removed. */
  clearStartedEffects(runId: string): number
  /** Delete all effect records for the given run IDs. Returns the number of records removed. */
  deleteEffectsForRuns(runIds: string[]): number
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
  /** When true, only one run of this process may be active (idle or running) at a time. Admission is enforced atomically by the store. @defaultValue false */
  singleton?: boolean
  /**
   * Event names this process may emit via `triggerEvent`.
   * Declared explicitly via the `emits` registration option.
   * Used by {@link Engine.getGraph} to build the static event flow graph.
   */
  emits?: string[]
}

/**
 * Request payload for atomically creating one or more runs for a single emitted event.
 */
export type RunCreateRequest = {
  processName: string
  eventName: string
  payload: unknown
  parentRunId?: string | null
  correlationId?: string
  context?: Record<string, unknown>
  depth?: number
  idempotencyKey?: string | null
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
  /** Atomically create runs for a single emitted event, applying event-scoped idempotency and singleton admission in one store operation. */
  createMany(requests: RunCreateRequest[]): Run[]
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
  /** Update the heartbeat and lease expiry for a running run. Returns `false` when the lease is no longer owned. */
  heartbeat(runId: string, leaseOwner: string, leaseExpiresAt: number): boolean
  /** Reclaim runs whose leases have expired (crash recovery). */
  reclaimStale(): Run[]
  /** Check whether an idempotency key has already been used. Diagnostic helper only; event admission is defined by {@link createMany}. */
  hasIdempotencyKey(key: string): boolean
  /** Retrieve all runs with a given idempotency key. Diagnostic helper only; identical keys may exist on different event names. */
  getByIdempotencyKey(key: string): Run[]
  /** Set the handler version on a run. */
  setHandlerVersion?(runId: string, version: string): void
  /** Count runs in a given state without loading them. */
  countByState?(state: ProcessState): number
  /** Retrieve a page of runs with total count, optionally filtered by state. */
  getByStatePaginated?(state: ProcessState | null, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number }
  /** Retrieve a page of runs with total count using operator-facing status semantics. */
  getByStatusPaginated?(status: RunStatus, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number }
  /** Check whether any runs exist in a given state without loading them. */
  hasState?(state: ProcessState): boolean
  /** Delete completed non-deferred runs older than the cutoff. Returns the deleted run IDs. */
  pruneCompletedBefore?(cutoffMs: number): string[]
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
  /**
   * Automatically prune completed non-deferred runs older than this duration.
   * Accepts either milliseconds or a compact string like `'30d'`, `'12h'`, `'15m'`, or `'500ms'`.
   * Effect records for deleted runs are pruned alongside them.
   */
  retention?: number | string
  /** Called when a run is retried after failure. */
  onRetry?: (run: Run, error: string, attempt: number) => void
  /** Called when a run exhausts its retry budget and is marked with dead-letter status. */
  onDead?: (run: Run, error: string) => void
  /** Called when a run transitions to `running`. */
  onRunStart?: (run: Run) => void
  /** Called when a run finishes, regardless of outcome (`completed` or `errored`). */
  onRunFinish?: (run: Run) => void
  /** Called when a run transitions to `errored`. */
  onRunError?: (run: Run, error: string) => void
  /** Lease duration in milliseconds for crash recovery. @defaultValue 30000 */
  leaseTimeoutMs?: number
  /**
   * Heartbeat interval in milliseconds (defaults to leaseTimeoutMs / 3).
   * Must be strictly less than {@link leaseTimeoutMs}, otherwise the lease expires
   * before the first heartbeat.
   * @throws {@link EngineError} with code {@link ErrorCode.INVALID_CONFIG} if >= leaseTimeoutMs.
   */
  heartbeatIntervalMs?: number
  /**
   * Called when an internal error is caught that would otherwise be silently swallowed.
   * The `context` string identifies the error site (e.g. `'fillSlots'`, `'heartbeat'`, `'onRunStart'`).
   */
  onInternalError?: (error: unknown, context: string) => void
  /**
   * Unified lifecycle event callback. Fires synchronously for every engine event.
   * Must not throw, exceptions are caught and reported to {@link onInternalError}
   * but deliberately not re-emitted as `internal:error` to prevent recursion.
   *
   * @example
   * ```ts
   * const engine = createEngine({
   *   onEvent(event) {
   *     if (event.type === 'run:complete') {
   *       console.log(`${event.run.processName} completed in ${event.durationMs}ms`)
   *     }
   *   },
   * })
   * ```
   */
  onEvent?: (event: EngineEvent) => void
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
   * @param opts - Optional retry policy, version, singleton flag, and emits declarations.
   */
  register(name: string, eventName: string, handler: Handler, opts?: { retry?: RetryPolicy; version?: string; singleton?: boolean; emits?: string[] }): void

  /**
   * Register a process handler with schema validation.
   * @typeParam T - The validated payload type.
   * @param name - Unique process name.
   * @param eventName - The event to listen for.
   * @param schema - Schema to validate payloads.
   * @param handler - The handler function receiving validated payloads.
   * @param opts - Optional retry policy, version, singleton flag, and emits declarations.
   */
  register<T>(
    name: string,
    eventName: string,
    schema: Schema<T>,
    handler: (ctx: HandlerContext<T>) => Promise<HandlerResult> | HandlerResult,
    opts?: { retry?: RetryPolicy; version?: string; singleton?: boolean; emits?: string[] },
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
   * Start recovery and dispatch after registration is complete.
   *
   * This is primarily relevant for persisted stores: call it after asynchronous
   * registration so recovered work is not consumed before its handlers exist.
   * Methods like {@link emit}, {@link emitAndWait}, {@link drain},
   * {@link retryRun}, {@link requeueDead}, and {@link resume} also start the
   * runtime automatically if needed.
   */
  start(): void

  /**
   * Emit an event, creating runs for all registered processes.
   * @param eventName - The event name to emit.
   * @param payload - The event payload.
   * @param opts - Optional idempotency key. Idempotency is scoped to the emitted event name.
   * @returns The newly created runs (empty if the engine is stopped, no handlers match, the event was already admitted for that key, or singleton admission dropped every matching process).
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
   * Emit an event and wait for the emitted root runs and their descendants to complete.
   * @param eventName - The event name to emit.
   * @param payload - The event payload.
   * @param opts - Optional idempotency key and timeout.
   * @returns The newly created runs with final state, or an empty array if the emit was skipped. Unrelated engine work does not affect this wait.
   */
  emitAndWait(eventName: string, payload: unknown, opts?: { idempotencyKey?: string; timeoutMs?: number }): Promise<Run[]>

  /**
   * Get all runs currently in `running` state.
   * @returns Array of running runs.
   */
  getRunning(): Run[]

  /**
   * Get all runs in `completed` state.
   * @deprecated Prefer `getRunsPaginated('completed', ...)` or `getRunsByStatusPaginated(...)` to avoid materializing all completed runs.
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
   * Retrieve a run and all of its descendants linked by parent/child relationships.
   * Pass a root run ID to obtain the full causal chain from the top.
   * @param runId - The root of the sub-chain to return.
   * @returns The run and all descendant runs, ordered by traversal.
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
   * Get the static event flow graph built from all registered processes.
   *
   * Returns a directed graph where nodes are processes and edges represent
   * event connections: an edge exists from process A to process B when A
   * declares an event in its `emits` array that matches B's `on` event.
   *
   * The graph is useful for visualization, pipeline validation, and the
   * dev dashboard's Graph tab.
   *
   * @returns The event flow graph with nodes and edges.
   *
   * @example
   * ```ts
   * const graph = engine.getGraph()
   * // graph.nodes: [{ name: 'validate', on: 'order:new', emits: ['order:validated'] }, ...]
   * // graph.edges: [{ from: 'validate', event: 'order:validated', to: 'charge' }, ...]
   * ```
   */
  getGraph(): EventGraph

  /** Count runs in a given state without loading them. */
  countByState(state: ProcessState): number

  /** Retrieve a page of runs with total count using operator-facing status semantics. */
  getRunsByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number }

  /** Retrieve a page of runs with total count, optionally filtered by state. */
  getRunsPaginated(state: ProcessState | null, limit: number, offset: number, opts?: RunQueryOptions): { runs: Run[]; total: number }

  /**
   * Get engine metrics combining store-derived queue state and runtime counters.
   *
   * `queue` values come from the persisted store and survive restarts.
   * `totals` are in-process counters accumulated since engine creation.
   */
  getMetrics(): EngineMetrics

  /**
   * Retrieve bucketed engine observability rollups for a time window.
   *
   * The result merges persisted buckets with any in-memory measurements that
   * have not been flushed yet, so the view stays fresh even with batched writes.
   */
  getObservability(query?: EngineObservabilityQuery): EngineObservabilityReport

  /**
   * Subscribe to engine lifecycle events as they happen.
   *
   * Intended for dashboards and streaming adapters that want low-latency
   * invalidation without replacing the durable observability rollups.
   *
   * Returns an unsubscribe function that removes the listener.
   */
  subscribeEvents(listener: (event: EngineEvent) => void): () => void

  /**
   * Retry an errored run. Resets it to idle state for re-execution.
   * @param runId - The errored run's ID.
   * @returns The updated run in idle state.
   * @throws {@link EngineError} with code {@link ErrorCode.RUN_NOT_FOUND} if the run does not exist.
   * @throws {@link EngineError} with code {@link ErrorCode.INVALID_RUN_STATE} if the run is not in errored state.
   */
  retryRun(runId: string): Run

  /**
   * Requeue a dead-letter run by resetting its attempt counter and state.
   * Unlike {@link retryRun}, this resets the attempt count so the full
   * retry budget is available again.
   * @param runId - The dead-letter run's ID.
   * @returns The updated run in idle state.
   * @throws {@link EngineError} with code {@link ErrorCode.RUN_NOT_FOUND} if the run does not exist.
   * @throws {@link EngineError} with code {@link ErrorCode.INVALID_RUN_STATE} if the run is not in `dead-letter` status.
   */
  requeueDead(runId: string): Run

  /**
   * Cancel an idle or running run, moving it to errored state.
   * Active handlers are aborted cooperatively through {@link HandlerContext.signal}
   * / {@link ProcessContext.signal}, and later engine-mediated context writes and
   * durable effects are fenced once cancellation takes effect.
   * @param runId - The run's ID.
   * @returns The cancelled run.
   * @throws {@link EngineError} with code {@link ErrorCode.RUN_NOT_FOUND} if the run does not exist.
   * @throws {@link EngineError} with code {@link ErrorCode.INVALID_RUN_STATE} if the run is not in idle or running state.
   */
  cancelRun(runId: string): Run

  /**
   * Resume a completed run whose handler returned `{ triggerEvent, deferred: true }`.
   * Emits the deferred `triggerEvent` as a chained event, continuing the correlation chain.
   * @param runId - The completed run's ID.
   * @param payload - Optional additional payload to merge with the stored result payload.
   * @returns The newly created child runs.
   * @throws {@link EngineError} with code {@link ErrorCode.RUN_NOT_FOUND} if the run does not exist.
   * @throws {@link EngineError} with code {@link ErrorCode.INVALID_RUN_STATE} if the run is not completed, has no triggerEvent, is not deferred, or no child run was admitted. When no child run is admitted, the run remains deferred.
   */
  resume(runId: string, payload?: unknown): Run[]

  /**
   * Stop the engine and tear down all internal timers (dispatcher, heartbeat, lease loop).
   * No new events will be accepted after calling this. If a dev server is running, it is
   * also closed. Once stopped, the engine no longer holds the Node.js event loop open.
   * @param opts - Optional graceful shutdown: `{ graceful: true }` pauses new claims,
   *   keeps heartbeats alive, and waits for in-flight handlers to finish before stopping.
   *   Without `graceful`, active handlers are aborted cooperatively before teardown.
   *   `timeoutMs` caps the wait (default: 30000ms).
   */
  stop(opts?: { graceful?: boolean; timeoutMs?: number }): Promise<void>

  /**
   * Wait for all idle and running runs to complete. This is the primary mechanism
   * for script-style usage where you emit events and want to block until all
   * engine work (including unrelated runs, chained events, and delayed retries)
   * finishes before exiting.
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
 * A node in the event flow graph, representing a registered process.
 * @see {@link Engine.getGraph}
 */
export type EventGraphNode = {
  /** Unique process name. */
  name: string
  /** The event this process listens for (its trigger). */
  on: string
  /** Events this process may emit, as declared via the `emits` registration option. Empty array if none declared. */
  emits: string[]
}

/**
 * A directed edge in the event flow graph. Represents a causal connection
 * where one process emits an event that another process listens for.
 * @see {@link Engine.getGraph}
 */
export type EventGraphEdge = {
  /** Source process name (the emitter). */
  from: string
  /** The event name connecting source to target. */
  event: string
  /** Target process name (the listener). */
  to: string
}

/**
 * The static event flow graph built from process registrations.
 * Represents the declared topology of your event pipeline, which
 * processes connect to which via emitted events.
 *
 * Useful for visualization, validation, and the dev dashboard Graph tab.
 * @see {@link Engine.getGraph}
 */
export type EventGraph = {
  /** All registered processes as graph nodes. */
  nodes: EventGraphNode[]
  /** Directed edges connecting emitters to listeners. */
  edges: EventGraphEdge[]
}

/**
 * Discriminated union of all engine lifecycle events emitted via {@link EngineOptions.onEvent}.
 *
 * - `run:start`, run claimed by dispatcher and about to execute.
 * - `run:complete`, handler returned `{ success: true }`. `durationMs` is current-attempt execution time.
 * - `run:error`, run reached errored state (handler threw, returned `{ success: false }`, or failed validation). `durationMs` is current-attempt execution time (0 if no handler ran).
 * - `run:retry`, handler threw but retries remain; run returns to idle.
 * - `run:dead`, retry budget exhausted; always followed by `run:error`.
 * - `run:resume`, a deferred run was resumed, creating child runs.
 * - `effect:complete`, durable effect executed successfully. `durationMs` is effect function wall-clock time.
 * - `effect:error`, durable effect threw. `durationMs` is time until the throw.
 * - `effect:replay`, durable effect replayed from store (no re-execution).
 * - `lease:reclaim`, a stale lease was reclaimed (one event per run).
 * - `internal:error`, an internal error was caught that would otherwise be swallowed.
 */
export type EngineEvent =
  | { type: 'run:start'; run: Run }
  | { type: 'run:complete'; run: Run; durationMs: number }
  | { type: 'run:error'; run: Run; error: string; durationMs: number }
  | { type: 'run:retry'; run: Run; error: string; attempt: number }
  | { type: 'run:dead'; run: Run; error: string }
  | { type: 'run:resume'; resumedRun: Run; childRuns: Run[] }
  | { type: 'effect:complete'; runId: string; effectKey: string; durationMs: number }
  | { type: 'effect:error'; runId: string; effectKey: string; error: string; durationMs: number }
  | { type: 'effect:replay'; runId: string; effectKey: string }
  | { type: 'lease:reclaim'; run: Run }
  | { type: 'internal:error'; error: unknown; context: string }

/**
 * Engine metrics combining store-derived state and runtime counters.
 *
 * `queue` values reflect the current persisted state and survive restarts.
 * `totals` are runtime counters accumulated since engine creation and reset on restart.
 */
export type EngineMetrics = {
  /** Current store-derived snapshot of runs by state. */
  queue: { idle: number; running: number; completed: number; errored: number }
  /** Runtime counters since engine creation (reset on restart). */
  totals: { retries: number; deadLetters: number; resumes: number; leaseReclaims: number; internalErrors: number }
}

/** Approximate duration histogram used for percentile estimation in observability rollups. */
export type DurationHistogram = {
  le10ms: number
  le50ms: number
  le100ms: number
  le250ms: number
  le500ms: number
  le1000ms: number
  le2500ms: number
  le5000ms: number
  le10000ms: number
  gt10000ms: number
}

/** Aggregated duration statistics for runs/effects over an observability bucket. */
export type DurationStats = {
  count: number
  sumMs: number
  minMs: number | null
  maxMs: number | null
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  histogram: DurationHistogram
}

/** Bucketed engine observability measurements for a fixed time interval. */
export type EngineObservabilityBucket = {
  bucketStart: number
  bucketSizeMs: number
  runs: {
    started: number
    completed: number
    failed: number
    retried: number
    deadLetters: number
    resumed: number
    successRate: number | null
    duration: DurationStats
  }
  effects: {
    completed: number
    failed: number
    replayed: number
    successRate: number | null
    duration: DurationStats
  }
  system: {
    leaseReclaims: number
    internalErrors: number
  }
}

/** Aggregated observability summary over the requested window. */
export type EngineObservabilitySummary = {
  runs: EngineObservabilityBucket['runs']
  effects: EngineObservabilityBucket['effects']
  system: {
    leaseReclaims: number
    internalErrors: number
    recentErrorCount: number
  }
}

/** Recent engine error record captured for observability dashboards. */
export type EngineObservabilityError = {
  id: number
  kind: 'run' | 'effect' | 'internal'
  createdAt: number
  processName: string | null
  runId: string | null
  effectKey: string | null
  context: string | null
  message: string
}

/** Query options for engine observability rollups. */
export type EngineObservabilityQuery = {
  from?: number
  to?: number
  bucketMs?: number
  errorLimit?: number
}

/** Observability report returned by {@link Engine.getObservability}. */
export type EngineObservabilityReport = {
  from: number
  to: number
  bucketSizeMs: number
  summary: EngineObservabilitySummary
  buckets: EngineObservabilityBucket[]
  recentErrors: EngineObservabilityError[]
}

/** Lightweight invalidation event streamed to dashboard clients over SSE. */
export type EngineStreamEvent = {
  kind: 'connected' | 'event'
  at: number
  topics: string[]
  eventType?: EngineEvent['type']
  runId?: string | null
  correlationId?: string | null
  processName?: string | null
  eventName?: string | null
  effectKey?: string | null
  context?: string | null
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
  /** Bind the server to a port and start listening. */
  serve(opts?: { host?: string; port?: number }): Promise<{ host: string; port: number }>
  /** Stop the dev server. */
  stop(): Promise<void>
}
