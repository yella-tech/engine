# @yellatech/engine

[![CI](https://github.com/yella-tech/engine/actions/workflows/ci.yml/badge.svg)](https://github.com/yella-tech/engine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Durable TypeScript runtime for agents and automations. Effects store their results, retries pick up where you left off.

Your agent is 10 steps deep when the process dies. With bare async/await, that work is gone. With Yella, every LLM response, tool result, and side effect is stored as it completes. Restart the process, and it picks up from the last completed step.

No platform. No infrastructure. One SQLite file. Just a library you import.

## Install

```bash
npm install @yellatech/engine
```

## Quick Start

```typescript
import { createEngine } from '@yellatech/engine'

const engine = createEngine({ store: { type: 'sqlite', path: './agent.db' } })

engine.process({
  name: 'research',
  on: 'topic:assigned',
  run: async (ctx) => {
    const payload = ctx.payload as { topic: string }
    // already called? returns the stored result.
    const analysis = await ctx.effect({
      key: 'llm-analyze',
      run: () => llm.chat(`Analyze: ${payload.topic}`),
    })

    return ctx.ok({ analysis }, { emit: 'topic:analyzed' })
  },
})

engine.emit('topic:assigned', { topic: 'durable execution models' })

// emitAndWait() waits only for the runs created by one emission and their descendants.
// drain() waits for all runs to finish, only needed in scripts and tests.
// in a server, emit() returns immediately and the dispatcher handles the rest.
await engine.drain()
await engine.stop()
```

## Why

### Completed effects do not re-run

`ctx.effect()` stores the result of any external call. If your handler retries after a crash, effects that already completed return their stored result. The function doesn't run again.

If recovery finds an effect record still in `started`, the engine fences that effect instead of running the side effect body a second time.

```typescript
const result = await ctx.effect({
  key: 'llm-summarize',
  run: () => llm.chat('Summarize this document'),
})
// if it already completed, retries return the stored result.
// $0.15 well spent, not $0.30.
```

### Just TypeScript

No replay engine, no determinism constraints, no framework DSL. Your handler re-executes from the top on every retry. Write async functions, use any library, branch however you want.

### Crash recovery

Lease-based heartbeating detects abandoned runs. When the process restarts, expired leases are reclaimed and runs resume with their stored effect results intact.

`engine.stop({ graceful: true })` keeps heartbeats alive while in-flight handlers finish. A hard stop aborts active handlers cooperatively through `ctx.signal` before the engine tears down leases and timers.

### Cooperative cancellation

Every handler receives an `AbortSignal` on `ctx.signal`. `cancelRun()` and hard `stop()` use it to abort active work, and later `ctx.setContext()` and `ctx.effect()` calls are fenced once the run is no longer active.

### Event chains

Handlers can emit follow-up events, building multi-step pipelines with full correlation tracking.

```typescript
engine.process({
  name: 'classify',
  on: 'ticket:new',
  run: async (ctx) => {
    const payload = ctx.payload as { text: string }
    const category = await ctx.effect({
      key: 'classify',
      run: () => llm.chat(`Classify this ticket: ${payload.text}`),
    })
    return ctx.ok({ category }, { emit: 'ticket:classified' })
  },
})

engine.process({
  name: 'route',
  on: 'ticket:classified',
  run: async (ctx) => {
    const payload = ctx.payload as { category: string }
    await ctx.effect({
      key: 'notify',
      run: () => slack.post(`#${payload.category}`, ctx.context),
    })
    return ctx.ok()
  },
})
```

Every run in a chain shares a correlation ID. A configurable max chain depth prevents infinite loops.

Deferred runs keep their next event on the completed run until `engine.resume(runId)` succeeds. If no child run is admitted during resume, the run stays deferred and `resume()` throws.

## Features

- **Durable effects** with completed-result replay and in-progress fencing
- **Configurable retries** with fixed or computed backoff delays
- **Lease-based crash recovery** with heartbeating
- **Event chaining** with correlation IDs and context propagation
- **Deferred and dead-letter statuses** for operator-facing pause/failure visibility
- **Lifecycle events and metrics** via `onEvent()` and `engine.getMetrics()`
- **Schema validation** via Zod (or any object with a `.parse()` method)
- **Atomic event admission** with event-scoped idempotency and singleton claims
- **Cooperative cancellation** via `AbortSignal` on every handler context
- **Concurrency control** with configurable parallelism
- **Built-in dev dashboard** for inspecting runs, traces, timelines, and graph views
- **SQLite persistence** via better-sqlite3 (WAL mode, prepared statements, migrations)
- **In-memory mode** for tests and scripts with structured-clone safety

## Storage

By default the engine runs in-memory. For persistence across restarts:

```typescript
// Option 1: pass a path
const engine = createEngine({ store: { type: 'sqlite', path: './app.db' } })

// Option 2: environment variable
// STATE_DB_PATH=./app.db node app.js
const engine = createEngine()
```

SQLite provides crash recovery, cross-restart idempotency, and the effect ledger. In-memory mode is useful for tests and short-lived scripts.

Payloads, context values, and handler results should be `structuredClone`-compatible. In-memory mode rejects values it cannot clone instead of storing shared object references.

## Waiting For Work

Use `emitAndWait()` when you want to block on one emitted chain only. It waits for the emitted root runs and their descendants, and ignores unrelated work elsewhere in the engine.

Use `drain()` when you want the whole engine to go idle, including unrelated runs and delayed retries.

## Observability

You can tap into lifecycle events at configuration time with `onEvent()`, add listeners later with `engine.subscribeEvents()`, inspect the current queue snapshot with `engine.getMetrics()`, and pull bucketed rollups with `engine.getObservability()`:

```typescript
const engine = createEngine({
  onEvent(event) {
    if (event.type === 'run:dead') {
      console.error(`[dead-letter] ${event.run.processName}: ${event.error}`)
    }
  },
})

const unsubscribe = engine.subscribeEvents((event) => {
  if (event.type === 'run:resume') {
    console.log(`resumed ${event.resumedRun.id} -> ${event.childRuns.length} child run(s)`)
  }
})

console.log(engine.getMetrics())
console.log(
  engine.getObservability({
    from: Date.now() - 60 * 60 * 1000,
    to: Date.now(),
  }).summary,
)

unsubscribe()
```

API and dashboard responses expose both the raw persisted `state` and a derived operator-facing `status`, so `completed` vs `deferred` and `errored` vs `dead-letter` stay distinguishable without changing the core state machine.

## Dev Dashboard

One line enables a built-in dashboard with overview trends, run inspection, traces, graph views, and manual event emission.

```typescript
const engine = createEngine({ server: { port: 3400 } })
```

The dashboard is a Preact app served from built static assets. It includes:

- **Overview**, live stats and recent runs
- **Processes**, registered process table with event graph visualization
- **Runs**, filterable run browser with root-only toggle
- **Trace**, Gantt timeline of execution chains with gap-collapsing
- **Graph**, static workflow topology from declared `emits`
- **Emit**, manual event emission for testing

Live invalidation uses SSE plus bounded refresh intervals for heavier views, so the dashboard stays responsive without hammering every endpoint continuously.

See the full dashboard guide and route reference:

- [Dashboard](https://yella.tech/engine/docs/dashboard)
- [Configuration](https://yella.tech/engine/docs/configuration)

## Examples

```bash
# General pipeline + dashboard
npm run example

# Deferred review + dead-letter + requeue
npm run example:approval

# Throughput sweep across concurrency levels
npm run load-test
```

### UI Component Library

The dashboard components are exported as a library via `@yellatech/engine/ui` for use by packages that extend the engine (e.g. `@yellatech/conduit`). The `DashboardShell` accepts custom tabs and panels, so consumers can add their own views without forking the dashboard.

For the operator UI migration plan and architecture reference, see the GitHub doc: [operator-ui-architecture.md](https://github.com/yella-tech/engine/blob/main/docs/operator-ui-architecture.md).

### Developing the Dashboard

```bash
# Terminal 1: run an engine example with a server
npm run example

# Terminal 2: Vite dev server with HMR (proxies API calls to :3000)
npm run dev:ui
```

The Vite dev server runs on port 5173 with hot module replacement. Edit any component in `src/ui/` and see changes instantly.

## Releases

Normal development should keep moving on `main` without bumping `package.json` or creating tags on every commit.

When you are actually ready to publish:

```bash
# 1. Add a changelog entry first:
#    ## 0.14.4 - YYYY-MM-DD

# 2. Cut the release commit and tag
npm run release -- 0.14.4

# 3. Or do the full release, including npm publish and git push
npm run release -- 0.14.4 --publish
```

The release script requires:

- a clean working tree
- a matching `CHANGELOG.md` heading for the target version
- passing `format:check`, `test`, and `build`

## Docs

Full documentation, architecture guide, and API reference at [yella.tech](https://yella.tech).

- [Getting Started](https://yella.tech/engine/docs/getting-started)
- [Dashboard](https://yella.tech/engine/docs/dashboard)
- [Configuration](https://yella.tech/engine/docs/configuration)
- [API Reference](https://yella.tech/engine/docs/api-reference)

## License

[MIT](LICENSE)
