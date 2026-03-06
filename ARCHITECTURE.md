# State Engine Architecture

## Overview

This package is an event-driven process engine with pluggable run storage.

Core behavior:

- Register one or more named processes (handlers) per event.
- Emit events to enqueue runs.
- Dispatcher claims idle runs up to a concurrency limit.
- Handlers can complete, error, set context, and trigger follow-up events.
- Runs are queryable for introspection (`idle`, `running`, `completed`, `errored`, chain traversal).

Storage backends:

- In-memory store (`createRunStore`)
- SQLite store (`createSqliteRunStore`)

## Runtime Components

### 1) Registry (`src/registry.ts`)

- Owns process definitions by `name` and by `event`.
- Enforces unique process name registration.
- Supports:
  - `register(name, event, handler)`
  - `register(name, event, schema, handler)`
  - `unregister(name)`

### 2) Bus (`src/bus.ts`)

Responsibilities:

- `enqueue(...)`
  - optional idempotency-key dedup
  - payload size guard (byte-based via `Buffer.byteLength`)
  - chain-depth guard
  - per-process `singleton` dedup (skips events when a run is already active)
  - run creation with parent/correlation/context propagation
- `executeRun(run)`
  - schema validation
  - timeout handling
  - handler execution
  - result payload size guard
  - retry logic on thrown errors (per-process or global `RetryPolicy`)
  - lifecycle hooks (`onRunStart`, `onRunFinish`, `onRunError`), guarded via `safeCallHook`
  - state/result persistence
  - trigger-event fan-out

### 3) Dispatcher (`src/bus.ts`)

- Pulls idle runs from store (`claimIdle(1)`) until reaching configured concurrency.
- Calls `executeRun` and refills slots on completion.
- Supervisor pattern: `fillSlots` wrapped in try/catch with exponential backoff (1s–30s cap).
- Drain callbacks individually guarded so one failure doesn't block the rest.
- Exposes `kick()`, `stop()`, `onDrain(fn)`, `waitForActive()`.
- Supports multiple concurrent drain waiters.
- `waitForActive()` resolves when active count reaches 0 (used by graceful stop).

### 3b) Lease-Based Crash Recovery

- Each engine instance generates a `leaseOwner` UUID on startup.
- `claimIdle` sets `leaseOwner`, `leaseExpiresAt`, and `heartbeatAt` on claimed runs.
- Dispatcher heartbeats every `leaseTimeoutMs / 3` via `setInterval`.
- All state transitions clear lease fields.
- On startup, `reclaimStale()` finds running runs with expired leases and returns them to idle.
- Reclaimed runs with exhausted retry budgets transition to errored.

### 4) Stores (`src/run.ts`, `src/run-sqlite.ts`)

Common contract (`RunStore`):

- Create, transition, result/context updates
- Claim idle runs
- Read APIs (`get`, filters, chain)
- Guard checks (`hasActiveRun`, `hasIdempotencyKey`)

SQLite specifics:

- Schema migration via `PRAGMA user_version` (5 migrations)
- WAL mode
- prepared statements
- transactional idle-claim
- unique composite index on `(idempotency_key, process_name)`, cross-process safe

### 4b) Effect Store (`src/effect.ts`, `src/run-sqlite.ts`)

- Tracks durable side effects per run via `ctx.effect(key, fn)`.
- Completed effects replay stored output on retry (no re-execution).
- Failed/crashed effects re-execute on retry.
- In-memory: `Map<runId, Map<effectKey, EffectRecord>>`.
- SQLite: `run_effects` table sharing the same Database instance via `createSqliteStores()`.

### 5) Engine Facade (`src/index.ts`)

Public API composition:

- `createEngine(opts)`
- `register`, `unregister`, `emit`
- `on(event, handler)`, auto-named register, returns name for unregister
- `registerMany(defs)`, batch registration
- `emitAndWait(event, payload, opts?)`, emit + drain + return fresh runs
- state/query methods (`getRunning`, `getCompleted`, etc.)
- `drain(timeoutMs)`
- `retryRun(id)`, retry an errored run (increments attempt)
- `requeueDead(id)`, requeue a dead-lettered run (resets attempt to 0)
- `cancelRun(id)`, cancel an idle or running run
- `stop(opts?)`, hard stop (default) or `{ graceful: true, timeoutMs? }` to wait for in-flight handlers
- `getServer()`, returns `Promise<DevServer> | null` for the dev dashboard

### 6) Dev Server (`src/server/`)

Optional built-in HTTP server with a dev dashboard UI, enabled via `server` option in `EngineOptions`.

- Uses **Hono** (~14KB, zero transitive deps) + `@hono/node-server`.
- Loaded via dynamic import, zero cost if `server` is not configured.
- Routes: `/health`, `/runs`, `/runs/:id`, `/runs/:id/chain`, `/runs/:id/trace`, `/emit`.
- Trace visualization: `buildTraceTree` + `flattenTrace` produce gantt-style span data.
- Dashboard UI: single `index.html` with polling, served at `/`.
- The Hono `app` is exposed on the `DevServer` handle for extension (custom routes).
- `engine.stop()` automatically closes the server; `server.stop()` closes only the server.

## Run Lifecycle

1. `emit(event, payload)` -> `bus.enqueue(...)` creates idle run(s).
2. `dispatcher.kick()` claims idle runs and transitions to `running`.
3. `executeRun` validates schema, runs handler, applies timeout and payload guards.
4. Run transitions:
   - `running -> completed` when `result.success === true`
   - `running -> errored` when handler fails or validation/guards fail
5. Optional chained event:
   - `result.triggerEvent` enqueues child run(s), preserving correlation/context.

State transition table (enforced by both stores):

- `idle -> running`
- `running -> completed | errored | idle` (idle = retry)
- terminal: `completed`, `errored`

## Guardrails Implemented

- Strict state transitions
- Max chain depth
- Max payload size (byte-based, input + result payload)
- Handler timeout
- Optional idempotency key dedup (SQLite: unique composite index, cross-process safe)
- Per-process singleton dedup (opt-in via `singleton: true` on process registration)
- Schema pre-validation (optional)
- Retry with backoff (per-process or global `RetryPolicy`, thrown errors only)
- Dead-letter queue (errored runs after retries exhaust, queryable via `getErrored()`)
- Typed errors (`EngineError` with `code` discriminator, `errorCode` on `HandlerResult`)

## Test Coverage Snapshot

As of March 5, 2026, local test status is:

- `13` files passed
- `380` tests passed

Covered areas include:

- Registry behavior
- In-memory and SQLite run store behavior
- Dispatcher concurrency/drain behavior (including multi-waiter)
- Engine chaining, context propagation, timeout path
- Guard-specific coverage:
  - transitions
  - chain depth
  - singleton process dedup
  - idempotency key (including SQLite unique constraint)
  - payload limits (ASCII + Unicode byte counting + circular payloads)
  - schema validation
- Convenience APIs: `on`, `registerMany`, `emitAndWait`
- SQLite restart persistence (file-based)
- Cross-process idempotency (SQLite unique constraint handling)
- Graceful stop (waits for in-flight, timeout, hard stop fallback)
- Retry/DLQ: retry on throw, exhaust to errored, delay scheduling, no retry on `{ success: false }`, per-process override, hooks (onRetry/onDead), context preservation, graceful stop with pending retries
- Lifecycle hooks: onRunStart (per attempt), onRunFinish/onRunError (terminal only), pre-handler error coverage, ordering guarantees, hook error isolation (safeCallHook)
- Error hardening: onInternalError observability, supervisor backoff recovery, drain callback isolation
- Typed errors: EngineError instanceof checks, ErrorCode discriminators on thrown errors and run results
- Lease-based crash recovery (in-memory and SQLite)
- Crash recovery integration tests (multi-engine claim/reclaim)
- Durable effects (ctx.effect): replay, crash recovery, multi-effect, serialization
- Idempotency duplicate returns
- Multi-worker correctness (SQLite shared DB)
- Repair APIs (retryRun, requeueDead, cancelRun)
- Handler version metadata
- State machine invariant exhaustiveness
- Dev server: health, runs, chain, trace, emit routes, dashboard HTML, custom route extension, server lifecycle

## Convenience API Candidates

Remaining candidates not yet implemented:

### `pipe`/`chain` helper for linear flows

```ts
engine.chain('ticket:new', [
  { name: 'triage', handler: triage },
  { name: 'assign', handler: assign },
  { name: 'notify', handler: notify },
])
```

Behavior:

- Generates intermediate trigger events automatically.
- Useful for common linear pipelines.

## Use Cases This Engine Fits Well

- Internal workflow orchestration in a single service process.
- Event-driven automation with lightweight fan-out and chaining.
- Durable background processing with SQLite persistence.
- Audit-friendly pipelines needing run history and correlation IDs.

Less ideal without extra hardening:

- Distributed multi-node workers sharing one queue.
- High-throughput broker replacement.

Note: idempotency keys with SQLite provide cross-process exactly-once semantics when
processes share the same database file (enforced via composite unique index + constraint
error handling in enqueue).
