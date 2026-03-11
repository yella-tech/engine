import type { Run, RunStatus } from './types.js'

/**
 * Determine whether a run should be presented as `deferred`.
 *
 * Deferred is a derived operator-facing status. The persisted run state
 * remains `completed`; this helper checks for the stored deferred marker
 * on the result payload.
 */
export function isDeferredRun(run: Pick<Run, 'state' | 'result' | 'timeline'> | null | undefined): boolean {
  return run?.state === 'completed' && run?.result?.deferred === true && typeof run.result?.triggerEvent === 'string'
}

/**
 * Determine whether a run should be presented as `dead-letter`.
 *
 * Dead-letter is a derived operator-facing status. The persisted run state
 * remains `errored`; this helper inspects the terminal timeline entry for
 * the dead-letter marker written when retry budget is exhausted.
 */
export function isDeadLetterRun(run: Pick<Run, 'state' | 'result' | 'timeline'> | null | undefined): boolean {
  if (run?.state !== 'errored') return false
  const lastEntry = run.timeline?.[run.timeline.length - 1]
  return lastEntry?.state === 'errored' && lastEntry.event === 'dead-letter'
}

/** Derive the operator-facing status for a run from its persisted state and metadata. */
export function getRunStatus(run: Pick<Run, 'state' | 'result' | 'timeline'>): RunStatus {
  if (isDeadLetterRun(run)) return 'dead-letter'
  return isDeferredRun(run) ? 'deferred' : run.state
}

/** Attach the derived {@link RunStatus} to a run object for API or UI consumption. */
export function withRunStatus<T extends Run>(run: T): T & { status: RunStatus } {
  return {
    ...run,
    status: getRunStatus(run),
  }
}

/** Map {@link withRunStatus} over a list of runs. */
export function withRunStatuses<T extends Run>(runs: T[]): Array<T & { status: RunStatus }> {
  return runs.map(withRunStatus)
}
