import type { Run, RunStore } from './types.js'

export type Dispatcher = {
  kick(): void
  pause(): void
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
  abortRun?: (runId: string, message: string) => void,
  onIdle?: (nextWakeAt: number | null) => void,
): Dispatcher {
  let active = 0
  let paused = false
  let drainFns: (() => void)[] = []
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  const scheduledTimers = new Set<ReturnType<typeof setTimeout>>()
  let backoffMs = 0
  const MAX_BACKOFF = 30_000
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let wakeAt = Infinity

  function notifyDrain(fns: (() => void)[]) {
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        onInternalError?.(err, 'drain')
      }
    }
  }

  function schedule(delayMs: number, fn: () => void) {
    const timer = setTimeout(() => {
      scheduledTimers.delete(timer)
      fn()
    }, delayMs)
    scheduledTimers.add(timer)
    return timer
  }

  function clearScheduledTimers() {
    for (const timer of scheduledTimers) {
      clearTimeout(timer)
    }
    scheduledTimers.clear()
    wakeTimer = null
    wakeAt = Infinity
  }

  /** Ensure a single wake-up timer exists for `at` (or earlier). */
  function ensureWake(at: number) {
    if (wakeTimer && wakeAt <= at) return
    if (wakeTimer) {
      clearTimeout(wakeTimer)
      scheduledTimers.delete(wakeTimer)
    }
    wakeAt = at
    wakeTimer = schedule(Math.max(0, at - Date.now()), () => {
      wakeTimer = null
      wakeAt = Infinity
      if (!paused) fillSlots()
    })
  }

  /** Report idleness when nothing is running and nothing is claimable right now. */
  function reportIdle(fromRunFinish: boolean) {
    if (active !== 0) return
    const next = runStore.nextRetryAt?.() ?? null
    if (next !== null) ensureWake(next)
    if (fromRunFinish || next !== null) {
      try {
        onIdle?.(next)
      } catch (err) {
        onInternalError?.(err, 'onIdle')
      }
    }
  }

  function fillSlots(fromRunFinish = false) {
    if (paused) return

    try {
      while (active < concurrency) {
        const claimed = leaseOpts ? runStore.claimIdle(1, leaseOpts.leaseOwner, leaseOpts.leaseTimeoutMs) : runStore.claimIdle(1)
        if (claimed.length === 0) break

        backoffMs = 0
        active++
        const runId = claimed[0].id

        if (leaseOpts) {
          const opts = leaseOpts
          const timer = setInterval(() => {
            try {
              const renewed = runStore.heartbeat(runId, opts.leaseOwner, Date.now() + opts.leaseTimeoutMs)
              if (!renewed) {
                clearInterval(timer)
                heartbeatTimers.delete(runId)
                abortRun?.(runId, 'run lease lost')
              }
            } catch (err) {
              onInternalError?.(err, 'heartbeat')
            }
          }, opts.heartbeatIntervalMs)
          heartbeatTimers.set(runId, timer)
        }

        executeRun(claimed[0])
          .finally(() => {
            const timer = heartbeatTimers.get(runId)
            if (timer) {
              clearInterval(timer)
              heartbeatTimers.delete(runId)
            }

            active--

            if (!paused) {
              try {
                const finished = runStore.get(runId)
                if (finished && finished.state === 'idle' && finished.retryAfter !== null && finished.retryAfter > Date.now()) {
                  ensureWake(finished.retryAfter)
                }
              } catch (err) {
                onInternalError?.(err, 'retrySchedule')
              }
            }

            if (paused) {
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
              fillSlots(true)
            } catch (err) {
              onInternalError?.(err, 'fillSlots')
            }
          })
          .catch((err) => {
            onInternalError?.(err, 'executeRun')
          })
      }
      reportIdle(fromRunFinish)
    } catch (err) {
      onInternalError?.(err, 'fillSlots')
      backoffMs = Math.min(MAX_BACKOFF, Math.max(1000, backoffMs * 2))
      schedule(backoffMs, () => {
        if (!paused) fillSlots()
      })
    }
  }

  function kick() {
    fillSlots()
  }

  function pause() {
    paused = true
  }

  function stop() {
    paused = true
    clearScheduledTimers()
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

  return { kick, pause, stop, onDrain, waitForActive }
}
