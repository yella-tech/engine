# @yella/engine

[![CI](https://github.com/yella-tech/engine/actions/workflows/ci.yml/badge.svg)](https://github.com/yella-tech/engine/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Durable TypeScript runtime for agents and automations. Effects store their results, retries pick up where you left off.

Your agent is 10 steps deep when the process dies. With bare async/await, that work is gone. With Yella, every LLM response, tool result, and side effect is stored as it completes. Restart the process, and it picks up from the last completed step.

No platform. No infrastructure. One SQLite file. Just a library you import.

## Install

```bash
npm install @yella/engine
```

## Quick Start

```typescript
import { createEngine } from '@yella/engine'

const engine = createEngine({ store: { path: './agent.db' } })

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

### Side effects run once

`ctx.effect()` stores the result of any external call. If your handler retries after a crash, effects that already completed return their stored result. The function doesn't run again.

```typescript
const result = await ctx.effect({
  key: 'llm-summarize',
  run: () => llm.chat('Summarize this document'),
})
// crashed after the call? returns the stored result.
// $0.15 well spent, not $0.30.
```

### Just TypeScript

No replay engine, no determinism constraints, no framework DSL. Your handler re-executes from the top on every retry. Write async functions, use any library, branch however you want.

### Crash recovery

Lease-based heartbeating detects dead workers. When the process restarts, expired leases are reclaimed and runs resume with their stored effect results intact.

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
- **Schema validation** via Zod (or any object with a `.parse()` method)
- **Idempotent event admission** with composite unique keys
- **Concurrency control** with configurable parallelism
- **Built-in dev dashboard** for inspecting runs, traces, and timelines
- **SQLite persistence** via better-sqlite3 (WAL mode, prepared statements, migrations)
- **In-memory mode** for tests and scripts that don't need durability

## Storage

By default the engine runs in-memory. For persistence across restarts:

```typescript
// Option 1: pass a path
const engine = createEngine({ store: { path: './app.db' } })

// Option 2: environment variable
// STATE_DB_PATH=./app.db node app.js
const engine = createEngine()
```

SQLite provides crash recovery, cross-restart idempotency, and the effect ledger. In-memory mode is useful for tests and short-lived scripts.

## Dev Dashboard

One line enables a built-in dashboard with Gantt traces of every run.

```typescript
const engine = createEngine({ server: { port: 3400 } })
```

## Docs

Full documentation, architecture guide, and API reference at [yella.tech](https://yella.tech).

## License

[AGPL-3.0-only](LICENSE)

This is a copyleft license. You can use, modify, and distribute the code freely. If you offer a modified version as a network service, you must make your source available under the same license. For most self-hosted and internal use, this has no practical impact.
