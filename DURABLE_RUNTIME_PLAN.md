# Durable Function Runtime Plan

## What This Product Is

This project is a lightweight durable function runtime for Node.js.

It is designed to make function execution:

1. Repeatable
2. Crash-recoverable
3. Observable
4. Operationally repairable

Core model:

1. Register one or more named handlers for events.
2. Emit events to create runs.
3. Dispatcher executes runs with concurrency control.
4. Runs persist state transitions (`idle`, `running`, `completed`, `errored`).
5. Handlers can trigger follow-up events (chaining).

Backends:

1. In-memory store for local/dev/testing.
2. SQLite store for durable local production workloads.

## Intended Delivery Semantics

The runtime should explicitly provide:

1. At-least-once handler execution.
2. Idempotent event admission (via idempotency keys).
3. Durable run state and replay/recovery.

Important implication:

1. At-least-once means handlers may run more than once after failures/recovery.
2. Side effects must be idempotent or engine-mediated through durable effect keys.

## How It Should Be Used

Use this engine when you need durable workflow execution in a single service or a small set of workers sharing SQLite.

Recommended usage pattern:

1. Treat handler input/output as serializable data.
2. Provide an `idempotencyKey` for each external command/request.
3. Put external side effects behind a durable effect helper (`ctx.effect`).
4. Keep handlers deterministic where possible.
5. Use retry policies for transient failures; send exhausted failures to DLQ.
6. Use run/query APIs and hooks for observability and operations.

Avoid using it as:

1. A high-throughput message broker replacement.
2. A fully distributed queue without additional coordination/storage hardening.

## API Shape Direction (No Breaking Changes Required)

The current public API can be extended without breaking existing interfaces.

Examples:

```ts
const engine = createEngine({
  store: { type: 'sqlite', path: 'runs.db' },
  retry: { maxRetries: 3, delay: (attempt) => 250 * (attempt + 1) },
})

engine.register('charge-card', 'billing:charge', async (ctx) => {
  const charge = await ctx.effect('stripe:charge', async () => {
    // External side effect: run once per (runId, effectKey), replay-safe
    return await stripe.charge(ctx.payload)
  })

  return { success: true, payload: charge }
})

await engine.emitAndWait('billing:charge', { invoiceId: 'inv_123' }, { idempotencyKey: 'invoice:inv_123:charge' })
```

## Prioritized Work Outline

### P0: Guarantees and Recovery

| Change | Reason for change | File(s) affected |
|---|---|---|
| Add explicit guarantees doc and tighten architecture wording (`at-least-once`, idempotency behavior, replay scope). | Removes ambiguity and aligns implementation/tests with stated contract. | `ARCHITECTURE.md`, new `GUARANTEES.md` |
| Add lease fields (`lease_owner`, `lease_expires_at`, `heartbeat_at`) via SQLite migration. | Enables crash recovery of in-flight (`running`) work. | `src/run-sqlite.ts`, `src/run-sqlite.test.ts` |
| Add heartbeat while handlers run and lease-aware claiming/reclaiming. | Prevents stuck runs and supports safe takeover. | `src/bus.ts`, `src/run-sqlite.ts`, `src/types.ts` |
| Reclaim expired leased runs on startup and return them to runnable state. | Makes recovery automatic after process crash/restart. | `src/index.ts`, `src/run-sqlite.ts`, `src/engine.test.ts` |

### P1: Idempotency and Effectively-Once Side Effects

| Change | Reason for change | File(s) affected |
|---|---|---|
| On duplicate idempotency key, return prior run(s) instead of empty list. | Makes repeats deterministic and easier to consume. | `src/bus.ts`, `src/run.ts`, `src/run-sqlite.ts`, `src/engine.test.ts` |
| Add durable effect ledger and `ctx.effect(effectKey, fn)`. | Main mitigation for at-least-once duplicate side effects. | `src/types.ts`, `src/bus.ts`, `src/run.ts`, `src/run-sqlite.ts`, `src/engine.test.ts` |
| Add multi-worker correctness tests using shared SQLite file. | Validates race behavior and recovery under realistic deployment. | `src/engine.test.ts`, `src/run-sqlite.test.ts` |

### P2: Operability and Replay Safety

| Change | Reason for change | File(s) affected |
|---|---|---|
| Persist handler version metadata on runs. | Replay/audit safety across deployments. | `src/types.ts`, `src/registry.ts`, `src/run.ts`, `src/run-sqlite.ts` |
| Add run repair APIs (`retryRun`, `requeueDead`, `cancelRun`). | Required for practical operations and incident response. | `src/index.ts`, `src/run.ts`, `src/run-sqlite.ts`, `src/engine.test.ts` |
| Expand invariants/regression tests for no-mutation and post-stop behavior. | Prevents guarantee regressions. | `src/run.test.ts`, `src/engine.test.ts` |

## Implementation Details

### 1) Durable `.effect` helper

Objective:

1. Permit handler retries/replays without repeating external side effects.

Proposed runtime behavior:

1. `ctx.effect(effectKey, fn)` checks a durable effect store keyed by `(runId, effectKey)`.
2. If a record exists in `succeeded` state, return stored output immediately.
3. If no record exists, mark `started`, execute `fn`, persist `succeeded` + serialized output, return output.
4. If `fn` throws, persist `failed` + error metadata and rethrow.
5. Retries call `ctx.effect` again and receive stored output (or retry failed effect per policy).

SQLite shape:

```sql
CREATE TABLE run_effects (
  run_id        TEXT NOT NULL,
  effect_key    TEXT NOT NULL,
  state         TEXT NOT NULL CHECK(state IN ('started','succeeded','failed')),
  output        TEXT,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  PRIMARY KEY (run_id, effect_key)
);
CREATE INDEX idx_run_effects_run_id ON run_effects(run_id);
```

Type direction:

```ts
type HandlerContext<T = unknown> = {
  // existing fields...
  effect<R>(effectKey: string, fn: () => Promise<R> | R): Promise<R>
}
```

Notes:

1. Keep API additive and backward compatible.
2. Only this pattern can provide effectively-once side effects under at-least-once handler execution.

### 2) Lease and heartbeat model

Objective:

1. Ensure `running` runs can be recovered if a worker dies.

Proposed fields:

1. `lease_owner: string | null`
2. `lease_expires_at: number | null`
3. `heartbeat_at: number | null`

Claim behavior:

1. A run is claimable if `state='idle'` or (`state='running'` and `lease_expires_at <= now`).
2. Claim sets state to `running` with a fresh lease owner and lease expiry.
3. During execution, heartbeat periodically extends `lease_expires_at`.

Recovery behavior:

1. Startup routine requeues stale `running` runs with expired lease.
2. Optionally append timeline entries: `running -> idle` with `error: lease expired`.

### 3) Duplicate idempotency result semantics

Current behavior:

1. Duplicate keys are rejected/no-op.

Desired behavior:

1. Duplicate emit returns existing run(s) for that key.
2. Caller can observe existing status/result deterministically.

Implementation direction:

1. Add store lookup by idempotency key + event/process scope.
2. `enqueue` returns existing matching run snapshots when key already exists.

### 4) Delivery semantics and developer ergonomics

Document and enforce:

1. Handlers are at-least-once.
2. Side effects must use `ctx.effect` (or external idempotency keys) to avoid duplicates.
3. Plain direct side effects in handler body are not replay-safe.

Recommended docs snippets:

1. "Use `ctx.effect` for email, billing, webhooks, and writes to external systems."
2. "Treat handler logic as replayable; treat side effects as step-keyed."

### 5) Operations and run repair

Add APIs:

1. `retryRun(runId)` for targeted retry of errored run.
2. `requeueDead(runId)` to move DLQ run back to idle.
3. `cancelRun(runId)` to prevent future execution.

Operational requirements:

1. Every repair action appends timeline/audit metadata.
2. Repair actions must respect state-transition rules.

## Delivery Plan Suggestion

1. Sprint 1: guarantees doc + lease schema + stale running recovery + tests.
2. Sprint 2: idempotency duplicate return behavior + `.effect` ledger + tests.
3. Sprint 3: repair APIs + version metadata + operational docs.

## Definition of Done

1. Guarantees are documented and tested.
2. Crash during handler execution recovers automatically.
3. Duplicate emits are deterministic.
4. Engine provides a built-in replay-safe side-effect primitive.
5. Operators can retry/requeue/cancel runs safely.
6. Multi-worker SQLite tests pass with race scenarios.
