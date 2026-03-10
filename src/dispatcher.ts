import type { Run, RunStore } from './types.js'

export type Dispatcher = {
  kick(): void
  stop(): void
  onDrain(fn: () => void): void
  waitForActive(): Promise<void>
}

export type LeaseOpts = {
  leaseOwner: string
  leaseTimeoutMs: number
  heartbeatIntervalMs: number
}

export function createDispatcher(
  runStore: RunStore,
  executeRun: (run: Run) => Promise<void>,
  concurrency: number,
  leaseOpts?: LeaseOpts,
  onInternalError?: (error: unknown, context: string) => void,
): Dispatcher {
  let active = 0
  let stopped = false
  let drainFns: (() => void)[] = []
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  let backoffMs = 0
  const MAX_BACKOFF = 30_000

  function notifyDrain(fns: (() => void)[]) {
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        onInternalError?.(err, 'drain')
      }
    }
  }

  function fillSlots() {
    if (stopped) return

    try {
      while (active < concurrency) {
        const claimed = leaseOpts ? runStore.claimIdle(1, leaseOpts.leaseOwner, leaseOpts.leaseTimeoutMs) : runStore.claimIdle(1)
        if (claimed.length === 0) break

        backoffMs = 0
        active++
        const runId = claimed[0].id

        // Start heartbeat interval if lease is configured
        if (leaseOpts) {
          const opts = leaseOpts
          const timer = setInterval(() => {
            try {
              runStore.heartbeat(runId, opts.leaseOwner, Date.now() + opts.leaseTimeoutMs)
            } catch (err) {
              onInternalError?.(err, 'heartbeat')
            }
          }, opts.heartbeatIntervalMs)
          heartbeatTimers.set(runId, timer)
        }

        executeRun(claimed[0]).finally(() => {
          // Clear heartbeat timer
          const timer = heartbeatTimers.get(runId)
          if (timer) {
            clearInterval(timer)
            heartbeatTimers.delete(runId)
          }

          active--

          // Schedule delayed retry if run was re-queued with a future retryAfter
          try {
            const finished = runStore.get(runId)
            if (finished && finished.state === 'idle' && finished.retryAfter !== null) {
              const delayMs = Math.max(0, finished.retryAfter - Date.now())
              if (delayMs > 0) {
                setTimeout(() => {
                  if (!stopped) fillSlots()
                }, delayMs)
              }
            }
          } catch (err) {
            onInternalError?.(err, 'retrySchedule')
          }

          if (stopped) {
            // Graceful stop: still notify drain waiters, just don't claim more work
            if (active === 0) {
              const fns = drainFns
              drainFns = []
              notifyDrain(fns)
            }
            return
          }
          try {
            const noIdle = runStore.hasState ? !runStore.hasState('idle') : runStore.getByState('idle').length === 0
            if (active === 0 && noIdle) {
              const fns = drainFns
              drainFns = []
              notifyDrain(fns)
            }
            fillSlots()
          } catch (err) {
            onInternalError?.(err, 'fillSlots')
          }
        })
      }
    } catch (err) {
      onInternalError?.(err, 'fillSlots')
      backoffMs = Math.min(MAX_BACKOFF, Math.max(1000, backoffMs * 2))
      setTimeout(() => {
        if (!stopped) fillSlots()
      }, backoffMs)
    }
  }

  function kick() {
    fillSlots()
  }

  function stop() {
    stopped = true
    for (const timer of heartbeatTimers.values()) {
      clearInterval(timer)
    }
    heartbeatTimers.clear()
  }

  function onDrain(fn: () => void) {
    drainFns.push(fn)
  }

  function waitForActive(): Promise<void> {
    if (active === 0) return Promise.resolve()
    return new Promise((resolve) => {
      drainFns.push(resolve)
    })
  }

  return { kick, stop, onDrain, waitForActive }
}
