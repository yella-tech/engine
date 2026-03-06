# Engine Guarantees

## Delivery Semantics

### At-Least-Once Handler Execution

Every emitted event that matches a registered handler will be executed at least once. If a worker crashes mid-execution, the lease expires and the run is reclaimed by the next engine instance on startup.

Handlers may execute more than once after crashes. Side effects must be idempotent or use `ctx.effect()`.

### Idempotent Event Admission

Providing an `idempotencyKey` on `emit()` ensures that only one set of runs is created per key. Duplicate emits return the existing runs.

SQLite enforces this across processes via a composite unique index on `(idempotency_key, process_name)`.

### Crash Recovery

Lease-based heartbeating protects running handlers:

1. Worker claims a run with a time-limited lease (default 30s).
2. Heartbeat extends the lease every `leaseTimeoutMs / 3` (default 10s).
3. If the worker dies, the lease expires.
4. Next engine startup reclaims expired-lease runs back to idle.
5. If a retry policy is set and the budget is exhausted, the run transitions to errored and fires `onDead`.

### Durable Side Effects

`ctx.effect(key, fn)` provides effectively-once execution for external side effects:

1. First call: executes `fn`, persists the result.
2. Replay (retry/recovery): returns the stored result without re-executing.
3. Crashed mid-effect (started but never completed): re-executes on retry.

Use `ctx.effect()` for charges, emails, webhooks, and writes to external systems.

## What This Engine Does NOT Guarantee

- **Exactly-once handler execution.** Handlers are at-least-once. Use `ctx.effect()` for side effects.
- **Distributed coordination.** The engine is designed for single-service or small worker sets sharing SQLite. It is not a distributed queue.
- **Ordering.** Runs are claimed in approximate insertion order but no strict FIFO is guaranteed under concurrency.
