# Benchmark Suite

This directory holds the repeatable benchmark suite for `@yellatech/engine`.

The suite exists to support product claims with raw artifacts:

- the harness source lives in [`run.ts`](./run.ts)
- the named scenario catalog lives in [`scenarios.ts`](./scenarios.ts)
- raw reports are written to [`../reports/benchmarks`](../reports/benchmarks)

## Goals

The suite is meant to answer practical questions:

- How does the engine behave as fleet concurrency changes?
- How much throughput do mixed API-style workloads sustain?
- What happens when one expensive task is capped independently from the rest of the engine?
- Can a memory-heavy browser-like step be bounded on a small machine?

It is not intended as a SQLite-vs-Postgres comparison.
It exists to show that Yella's runtime shape is deliberate, solid, and measurable.

## Scenario Families

Public benchmark scenarios:

- `api-mixed__fleet-c20`
- `api-mixed__fleet-c50`
- `api-mixed__fleet-c200`
- `scraper-bounded__fleet-c40__scraper-c1`
- `scraper-bounded__fleet-c40__scraper-c5`
- `scraper-bounded__fleet-c40__scraper-c10`

Internal trust scenarios:

- `burst-recovery__fleet-c50`
- `burst-recovery__scraper-capped`
- `degraded-downstream__api-mixed`
- `degraded-downstream__scraper-capped`
- `overnight-soak__api-mixed`
- `overnight-soak__scraper-bounded`
- `crash-recovery__mid-load__api-mixed`
- `crash-recovery__mid-load__scraper-bounded`

Family intent:

- `api-mixed` exercises varied webhook, billing, document, and approval flows with durable effects, retries, and slow outliers.
- `scraper-bounded` mixes normal API work with a browser-like task that allocates memory intentionally. The scraper process has its own per-process concurrency cap, independent from the global fleet limit.
- `burst-recovery` proves that bursts create queueing but the runtime drains and stabilizes afterward.
- `degraded-downstream` injects slow and rate-limited downstream behavior to show retry and dead-letter behavior.
- `overnight-soak` is the long-running stability pass for memory, WAL growth, and queue recovery.
- `crash-recovery` is a deliberate restart drill against the same SQLite store. It is not a SIGKILL chaos test, but it exercises the recovery path in a repeatable way.

## Running

```bash
# list scenarios and groups
npm run benchmark:list

# run one scenario
npm run benchmark -- api-mixed__fleet-c50

# run only public benchmark scenarios
npm run benchmark -- public

# run recovery drills
npm run benchmark -- recovery

# run the full suite
npm run benchmark -- all
```

You can also override the report directory:

```bash
npm run benchmark -- api-mixed__fleet-c50 --report-dir=examples/reports/benchmarks
```

Scale durations for faster verification:

```bash
# 5 percent of the normal duration, with per-phase minimums
npm run benchmark -- crash-recovery__mid-load__api-mixed --scale=0.05
```

## Report Naming

Reports are written with stable scenario IDs and timestamps:

- `api-mixed__fleet-c50__20260329-143000.txt`
- `api-mixed__fleet-c50__20260329-143000.json`

The text file is the full human-readable benchmark log.
The JSON file is a compact summary suitable for site copy, tables, or chart generation.
