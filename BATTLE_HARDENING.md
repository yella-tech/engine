# Engine Battle-Hardening Notes

Date: 2026-03-11

This is a short reminder for future work on `@yellatech/engine`.

## Boundary

`engine` should stay the small, durable core:

- execution semantics
- retries and resume
- durable effects
- storage behavior
- a minimal dev dashboard and internal API

`conduit` should carry the more opinionated product layer:

- connectors
- auth
- richer server behavior
- OTEL/export integrations
- broader operational UX

If that boundary stays intact, `engine` gets more trustworthy and easier to adopt.

## Priority Order

1. Semantics and guarantees
2. Failure-mode and storage-parity tests
3. Startup, shutdown, and recovery robustness
4. Observability hooks and metrics
5. Retention and performance
6. Optional OTEL adapter work
7. Dev dashboard polish

## 1. Semantics and Guarantees

Where:

- `src/types.ts`
- `src/index.ts`
- `src/bus.ts`
- `src/run.ts`
- `src/run-sqlite.ts`
- `README.md`

Change:

- Make the contract explicit: handler delivery semantics, effect replay semantics, idempotency scope, retry rules, resume rules, and shutdown guarantees.
- Be precise about the execution model: single-process embedded runtime vs. any supported multi-worker/SQLite shape.
- Normalize behavior across memory and SQLite for all public APIs.

Why:

This package becomes useful when its behavior is boring and predictable under stress.

## 2. Failure-Mode and Storage-Parity Tests

Where:

- `src/*.test.ts`
- especially `src/engine.test.ts`, `src/server.test.ts`, `src/run.test.ts`, `src/run-sqlite.test.ts`

Change:

- Run the same public-API scenarios against memory and SQLite.
- Add tests for malformed admin inputs, duplicate emits, duplicate resume/retry, lease expiry, crash/restart, migration upgrades, and shutdown during active work.
- Prefer parity tests around routes and pagination, not just core runtime happy paths.

Why:

The important bugs here will come from edge conditions, not from simple success cases.

## 3. Startup, Shutdown, and Recovery Robustness

Where:

- `src/index.ts`
- `src/dispatcher.ts`
- `src/server/index.ts`
- `src/server/routes.ts`

Change:

- Make server startup fail fast and reject clearly on listen errors.
- Tighten `stop()` and `drain()` semantics so they are deterministic under failure and active work.
- Keep recovery behavior explicit around stale leases, retries, and resumed runs.
- Make admin routes strict and consistent about invalid input.

Why:

This is the area most likely to create hangs, stuck work, or confusing operator behavior.

## 4. Observability Hooks and Metrics

Where:

- `src/types.ts`
- `src/bus.ts`
- `src/dispatcher.ts`
- `src/index.ts`

Change:

- Define a stable lifecycle event shape for run start, finish, retry, dead-letter, lease expiry, resume, and internal errors.
- Add first-class counters and timings: queue depth, active runs, completed runs, errored runs, retries, dead-letter count, handler duration, effect duration.
- Keep correlation IDs and run IDs easy to carry into logs and external systems.

Why:

Before OTEL, the engine needs a clean, stable internal observability surface.

## 5. Retention and Performance

Where:

- `src/run-sqlite.ts`
- `src/effect.ts`
- `src/server/trace.ts`
- route handlers that return run histories

Change:

- Plan for pruning old runs and effects.
- Verify indexes and query shapes for large histories.
- Benchmark trace, pagination, and effect queries against realistic data volume.
- Keep migrations simple and predictable.

Why:

Durable runtimes quietly accumulate data. The engine needs a story for growth before it hurts.

## 6. OTEL as an Adapter, Not a Core Dependency

Where:

- likely a small integration layer after the hook surface is stable

Change:

- Build OTEL integration on top of lifecycle hooks and metrics, not inside core execution semantics.
- Treat OTEL as optional export glue, not as a required mental model for users.

Why:

That keeps `engine` small and MIT-friendly while still letting `conduit` or downstream apps integrate with standard observability stacks.

## 7. Dashboard Positioning

Where:

- `src/server/*`
- `src/ui/*`

Change:

- Keep the dashboard explicitly dev-focused.
- Favor correctness and introspection over visual polish.
- Treat the internal HTTP API as the more important surface, since other packages are likely to build on it.

Why:

A plain dashboard with accurate engine state is more valuable than a polished UI with fuzzy semantics.

## Immediate Follow-Ups After the Current Review Findings

If the review findings are fixed, the next concrete pass should focus on:

- documenting exact guarantees in `README.md` and `src/types.ts`
- adding memory/SQLite parity tests for routes and admin actions
- hardening startup/shutdown/recovery paths
- defining a stable observability event model

That should make `engine` feel reliable enough for `conduit` to depend on without compensating for unclear core behavior.
