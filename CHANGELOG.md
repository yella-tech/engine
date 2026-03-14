# Changelog

## 0.14.0 - 2026-03-14

### Added
- Added `Engine.start()` as an explicit recovery barrier so persisted work can be reclaimed only after handlers have finished registering.
- Added a repair path for runs blocked by effects stuck in `started`, including operator APIs that clear stale in-progress effect fences before retry or requeue.

### Changed
- Recovery now waits behind the explicit runtime start barrier instead of beginning automatically during engine construction.
- Retention pruning now works bottom-up across successive sweeps so completed roots are not removed before callers observing descendant completion can finish.

### Fixed
- Rejected cross-origin browser mutation requests to the local dev server control plane while preserving same-origin and non-browser operator flows.
- Fenced stale handlers after lease loss and heartbeat failure so reclaimed work cannot continue mutating run state under the wrong lease owner.
- Returned aborted runs to `idle` on hard stop instead of leaving them stuck in `running`.
- Preserved idempotency reservations across SQLite schema upgrades by backfilling historical emission keys into the new reservation table.
- Preserved singleton admission across SQLite schema upgrades by falling back to legacy active-run checks when singleton metadata is absent.
- Ensured triggered child runs inherit the durable stored context rather than non-persisted handler-local mutations.
- Surfaced triggered-child admission failures on the parent run instead of silently truncating the chain.
- Prevented retention from breaking `emitAndWait()` by pruning completed run trees leaf-first instead of removing an entire completed subtree in one sweep.
