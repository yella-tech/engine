# Operator UI Architecture

Status: active reference

This document is the working architecture reference for the operator UI in
`@yellatech/engine` and for downstream packages that extend it, especially
`@yellatech/conduit`.

It is intentionally written as an implementation guide, not marketing copy.
Future code changes, docs, and agent work should use this file as the primary
source of truth for the dashboard/runtime migration.

If implementation diverges from this document, update the document and the code
in the same change.

## Purpose

The operator UI has grown from a small internal dashboard into a reusable UI
surface consumed by downstream packages. The current UI works visually, but its
architecture is too coupled:

- orchestration lives inside view components
- live updates are scattered across the shell and panels
- server data and local UI state are mixed together
- extension happens through broad shell contracts and low-level hooks
- downstream packages duplicate orchestration instead of plugging into it

The goal of this document is to define the target architecture and the migration
plan so the work stays deliberate.

## Scope

This document covers:

- the dashboard UI in `src/ui/`
- the engine server/dashboard HTTP surface in `src/server/`
- compatibility requirements for downstream consumers
- the migration path for `@yellatech/conduit`
- UI testing strategy

This document does not cover:

- engine runtime semantics unrelated to the dashboard
- marketing/docs site architecture
- visual redesign

## Constraints

### Product and package constraints

- `@yellatech/engine` is published on npm.
- The UI is not a live SaaS product, but package consumers may still exist.
- Public exports and route shapes must be treated as potentially used.

### Downstream compatibility constraints

`@yellatech/conduit` currently extends the UI and server through real package
seams. In particular:

- it uses `DashboardShell`
- it passes `DashboardConfig`
- it consumes `DashboardContext`
- it composes engine panels and hooks from `@yellatech/engine/ui`
- it mounts additional Hono routes on the same app

That means migration must preserve compatibility for conduit until conduit is
migrated to the new extension model.

### Technical constraints

- keep the stack lightweight
- keep memory footprint low
- avoid broad framework churn
- avoid turning the internal dashboard into an Astro-first app
- do not rely on live SSE just to make the UI testable

## Stack Decision

The operator UI stack remains:

- Hono for server/runtime hosting
- Preact for the operator UI

Astro may be used at the outer site shell level or to host the dashboard as one
coarse island, but Astro islands are not the primary architecture for the
dashboard internals.

Reasons:

- the dashboard is now a connected stateful app, not a set of isolated widgets
- overlay, runs, trace, graph, ticker, filters, and live updates share state
- multiple islands would still require a shared client store and query layer
- the package-level UI must remain reusable outside the site

## Public Compatibility Surface

The following are treated as public until explicitly deprecated and removed in a
documented release:

### Package exports

- `@yellatech/engine`
- `@yellatech/engine/server`
- `@yellatech/engine/ui`

### Engine UI surface

- `DashboardShell`
- `DashboardConfig`
- `DashboardContext`
- `Nav`
- exported panels from `@yellatech/engine/ui`
- existing utility exports that downstream packages are already consuming

### Server surface

- `registerRoutes`
- `createDevServer`
- `serveDashboard`
- current dashboard/API routes and their documented response shapes
- current SSE payload shape

### Compatibility rule

During migration:

- `DashboardShell` must continue to accept the current `DashboardConfig`
- `DashboardContext` must continue to expose the fields used by conduit
- hidden route/tab behavior remains supported until the plugin system lands
- existing route paths remain stable unless replaced additively

## Current Migration Baseline

The first migration slice already exists:

- `DashboardShell` is now a thin compatibility wrapper
- runtime state has started moving into `src/ui/runtime/`
- `NavView` exists so the shell can own route state without breaking `Nav`

This is only the beginning. The UI is not yet fully testable or fully moved to
the target model.

## Target Client Architecture

The client architecture is split into four layers:

1. compatibility shell
2. runtime/session state
3. query/cache state
4. live invalidation and plugins

### 1. Compatibility shell

`DashboardShell` remains the public entry point during migration.

Responsibilities:

- accept `DashboardConfig`
- adapt internal runtime state to `DashboardContext`
- call `renderPanel(tab, ctx)` exactly as current consumers expect

Non-responsibilities:

- data orchestration
- polling
- SSE coordination
- complex state transitions

### 2. Runtime/session state

The runtime owns UI coordination state. This is a small central store, not a
global dump of all remote data.

It should contain:

- route state
- overlay open/closed and selected IDs
- emit form draft
- ticker messages
- lightweight view preferences
- live connection state

It should not contain:

- all runs
- all trace payloads
- all graph payloads
- all observability reports

Those belong in the query runtime.

### 3. Query runtime

The query runtime is a small keyed cache for remote resources.

It is intentionally lightweight. The goal is not to recreate a full external
data framework; the goal is to stop embedding fetch logic in components.

Responsibilities:

- key resources by query identity
- cache active resources
- invalidate by tag
- abort stale fetches
- evict inactive/heavy resources
- provide route-aware refresh behavior

Target characteristics:

- small TTL/LRU cache
- one active fetch per key
- no duplicate polling per panel
- large payloads evicted aggressively on route changes

Likely resources:

- `overview`
- `runs:list`
- `runs:overlay`
- `runs:trace`
- `graph`
- `connectors:list`
- `connectors:observability`

### 4. Live bus

There should be one live update coordination layer per app, not per panel.

Responsibilities:

- maintain the active stream subscription(s)
- normalize incoming live events
- map live events to invalidation tags
- notify the query runtime

Non-responsibilities:

- mutating UI state directly beyond connection status
- panel-specific refresh rules

The live bus should be able to use:

- a real SSE source in production
- an in-memory fake source in tests

## Dashboard Runtime Dependencies

The runtime must become testable through dependency injection.

Target dependency shape:

```ts
type DashboardRuntimeDeps = {
  rpc: EngineRpcClient
  navigate: (path: string) => void
  now: () => number
  timers: {
    setTimeout: typeof window.setTimeout
    clearTimeout: typeof window.clearTimeout
  }
  live: {
    subscribe: (listener: (event: unknown) => void) => () => void
  }
}
```

Notes:

- production code provides real dependencies
- tests provide fake RPC, fake timers, fake live events
- this is the key to UI testing without booting the whole app

## Plugin Model

The current extension model is implicit. Conduit proves that consumers can
extend the UI, but the seam is too broad and too low-level.

The target model is an explicit plugin contract.

Target shape:

```ts
type DashboardPlugin = {
  id: string
  routes: RouteDef[]
  nav: NavItem[]
  panels: Record<string, PanelComponent>
  queries?: QueryRegistration[]
  live?: {
    streamUrl: (route: RouteState) => string | null
    mapEventToTags: (event: unknown, route: RouteState) => string[]
  }
}
```

Interpretation:

- engine base screens become one plugin
- conduit becomes another plugin
- plugin registration replaces downstream orchestration duplication

This plugin model should not be public until the compatibility shell is stable
and the core runtime contracts are proven.

Current engine status:

- the base engine dashboard is now composed through an internal plugin adapter
- the internal implementation lives behind `createDashboardConfigFromPlugins(...)`
- the engine base screens are registered through an internal engine-core plugin
- this plugin seam is still intentionally not exported from `engine/ui`

## Target Server Architecture

The server side remains Hono-based, but route modules become thin mounts over
services.

### Keep public route mounts

- `registerRoutes`
- `createDevServer`
- `serveDashboard`

### Move logic behind services

Engine side services:

- `OverviewReadService`
- `RunsReadService`
- `OverlayReadService`
- `TraceReadService`
- `GraphReadService`
- `CommandService`
- `LiveEventService`

Conduit side services:

- `ConnectorsReadService`
- `ConnectorObservabilityService`
- `AuthConfigService`
- `ConnectorConfigService`
- `ConduitLiveEventService`

Route modules should become:

- parameter parsing
- service invocation
- HTTP response shaping

They should stop being the place where most business/read-model logic lives.

## Contracts

Shared DTOs and live payloads should move out of route implementation files.

This is required because browser code should not depend on server route
implementation types directly.

Target contracts include:

- dashboard DTOs
- query result DTOs
- command result DTOs
- live event DTOs or invalidation event DTOs

## Testing Strategy

The UI must become testable without a running server.

### Tooling

Add:

- `jsdom`
- `@testing-library/preact`

### Test levels

#### Runtime tests

Focus on runtime/controller behavior with fake deps:

- stale overlay responses do not overwrite current selection
- overview live invalidation schedules the right refresh behavior
- retry/requeue/resume trigger expected refresh paths
- route transitions clean up heavy state correctly

#### Shell compatibility tests

Focus on `DashboardShell` compatibility:

- it accepts the current `DashboardConfig`
- it calls `renderPanel(tab, ctx)`
- `DashboardContext` exposes the expected fields
- conduit-style usage remains valid during migration

#### Plugin tests

Once plugins exist:

- engine plugin panels resolve correctly
- conduit plugin routes and panels register correctly

### Fixture mode

Provide a local fixture mode for manual smoke testing:

- no real SSE
- canned query results
- predictable route data

This helps manual review without requiring a full backend.

## Memory Constraints

The architecture must remain conservative about memory use.

Rules:

- one live connection per app
- no panel-level long-lived event sources
- no long-lived cache of inactive heavy payloads
- no global storage of all run history in memory
- traces and graphs are evicted aggressively when inactive
- ticker history is bounded

The intended model is small session state + bounded query cache.

## Migration Plan

### Phase 1: freeze compatibility seams

- document the public compatibility surface
- do not break `DashboardShell`, `DashboardConfig`, or `DashboardContext`
- do not break current route paths casually

### Phase 2: finish shell/runtime split

- move orchestration behind runtime modules
- keep the shell as a wrapper
- keep conduit working unchanged

### Phase 3: runtime dependency injection

- add runtime deps
- replace hardwired globals in the runtime
- make live updates and timers injectable

### Phase 4: real UI tests

- add runtime tests
- add compatibility shell tests
- establish the dashboard test harness

### Phase 5: query runtime

This is the trickiest phase.

Deliverables:

- resource keys
- invalidation tags
- cache lifecycle rules
- fetch cancellation rules
- heavy-payload eviction rules

This phase must be designed before it is broadly implemented, because its
choices leak into every panel and every downstream plugin.

### Phase 6: live bus

- centralize live updates
- convert stream events into invalidation tags
- remove duplicated polling/SSE logic from panels

### Phase 7: plugin API

- design and prove the plugin contract in engine
- keep it internal until stable

### Phase 8: migrate conduit

- move conduit UI extension to the plugin/runtime model
- remove duplicated app orchestration from conduit

### Phase 9: route-service split

- move engine and conduit route logic behind services
- keep public route mount APIs stable

### Phase 10: deprecations

- mark low-level old seams as deprecated
- keep wrappers for a migration cycle
- remove only in a documented release

## Deprecation Policy

Because engine is published on npm, deprecations should be intentional.

### Safe to change aggressively

- internal runtime modules
- internal services
- internal state shapes not publicly exported

### Deprecated before removal

- low-level UI hooks that expose the wrong architecture
- orchestration-oriented exports that downstream packages should stop depending on

### Conservative removal policy

- package exports
- `DashboardShell` compatibility surface
- route shapes
- SSE payloads

## Implementation Guidance For Future Agents

When continuing this work:

1. read this document first
2. identify which phase the change belongs to
3. do not break the current shell contract unless the phase explicitly allows it
4. prefer additive seams over abrupt replacement
5. keep code and document in sync

When unsure:

- preserve compatibility
- keep internals movable
- keep memory use bounded
- favor testability over cleverness

## Immediate Next Work

The next concrete work items are:

1. define `DashboardRuntimeDeps`
2. make the runtime fully dependency-driven
3. add the first real UI tests
4. design the `QueryRuntime` contract before implementing phase 5 broadly

This sequence is deliberate. The UI should become testable before the query
runtime spreads through the codebase.
