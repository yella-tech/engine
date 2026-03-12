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
    // already called? returns the stored result.
    const analysis = await ctx.effect({
      key: 'llm-analyze',
      run: () => llm.chat(`Analyze: ${ctx.payload.topic}`),
    })

    return ctx.ok({ analysis }, { emit: 'topic:analyzed' })
  },
})

engine.emit('topic:assigned', { topic: 'durable execution models' })

// drain() waits for all runs to finish, only needed in scripts and tests.
// in a server, emit() returns immediately and the dispatcher handles the rest.
await engine.drain()
await engine.stop()
```

## Why

### Completed effects do not re-run

`ctx.effect()` stores the result of any external call. If your handler retries after a crash, effects that already completed return their stored result. The function doesn't run again.

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

### Event chains

Handlers can emit follow-up events, building multi-step pipelines with full correlation tracking.

```typescript
engine.process({
  name: 'classify',
  on: 'ticket:new',
  run: async (ctx) => {
    const category = await ctx.effect({
      key: 'classify',
      run: () => llm.chat(`Classify this ticket: ${ctx.payload.text}`),
    })
    return ctx.ok({ category }, { emit: 'ticket:classified' })
  },
})

engine.process({
  name: 'route',
  on: 'ticket:classified',
  run: async (ctx) => {
    await ctx.effect({
      key: 'notify',
      run: () => slack.post(`#${ctx.payload.category}`, ctx.context),
    })
    return ctx.ok()
  },
})
```

Every run in a chain shares a correlation ID. A configurable max chain depth prevents infinite loops.

## Features

- **Durable effects** with per-key deduplication across retries
- **Configurable retries** with fixed or computed backoff delays
- **Lease-based crash recovery** with heartbeating
- **Event chaining** with correlation IDs and context propagation
- **Deferred and dead-letter statuses** for operator-facing pause/failure visibility
- **Lifecycle events and metrics** via `onEvent()` and `engine.getMetrics()`
- **Schema validation** via Zod (or any object with a `.parse()` method)
- **Idempotent event admission** with composite unique keys
- **Concurrency control** with configurable parallelism
- **Built-in dev dashboard** for inspecting runs, traces, timelines, and graph views
- **SQLite persistence** via better-sqlite3 (WAL mode, prepared statements, migrations)
- **In-memory mode** for tests and scripts that don't need durability

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

## Observability

You can subscribe to lifecycle events and inspect the current queue snapshot without bringing in another dependency:

```typescript
const engine = createEngine({
  onEvent(event) {
    if (event.type === 'run:dead') {
      console.error(`[dead-letter] ${event.run.processName}: ${event.error}`)
    }
  },
})

console.log(engine.getMetrics())
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

### Developing the Dashboard

```bash
# Terminal 1: run an engine example with a server
npm run example

# Terminal 2: Vite dev server with HMR (proxies API calls to :3000)
npm run dev:ui
```

The Vite dev server runs on port 5173 with hot module replacement. Edit any component in `src/ui/` and see changes instantly.

## Docs

Full documentation, architecture guide, and API reference at [yella.tech](https://yella.tech).

- [Getting Started](https://yella.tech/engine/docs/getting-started)
- [Dashboard](https://yella.tech/engine/docs/dashboard)
- [Configuration](https://yella.tech/engine/docs/configuration)
- [API Reference](https://yella.tech/engine/docs/api-reference)

## License

[MIT](LICENSE)
