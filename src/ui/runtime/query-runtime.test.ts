import { describe, expect, it, vi } from 'vitest'
import { DashboardQueryRuntime } from './query-runtime'

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
}

function createManualRuntimeClock() {
  let now = 0
  let nextId = 1
  const tasks = new Map<number, { at: number; callback: () => void }>()

  const timers = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextId++
      tasks.set(id, { at: now + delayMs, callback })
      return id as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => {
      tasks.delete(handle as unknown as number)
    },
  }

  return {
    now: () => now,
    timers,
    async advanceBy(delayMs: number) {
      now += delayMs

      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= now)
          .sort((left, right) => left[1].at - right[1].at)

        if (due.length === 0) return

        for (const [id, task] of due) {
          tasks.delete(id)
          task.callback()
        }

        await Promise.resolve()
      }
    },
  }
}

describe('DashboardQueryRuntime', () => {
  it('deduplicates active fetches for the same key', async () => {
    const clock = createManualRuntimeClock()
    const runtime = new DashboardQueryRuntime({
      now: clock.now,
      timers: clock.timers,
    })

    const fetcher = vi.fn(async () => ({ runs: [1] }))
    const notify = vi.fn()
    const query = {
      key: ['runs:list', { offset: 0 }],
      fetcher,
      tags: ['runs'],
    }

    const stopA = runtime.observe(query, notify)
    const stopB = runtime.observe(query, notify)

    await flushAsyncWork()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(runtime.getSnapshot<{ runs: number[] }>(query.key).data).toEqual({ runs: [1] })

    stopA()
    stopB()
    runtime.dispose()
  })

  it('refetches active queries when their invalidation tags fire', async () => {
    const clock = createManualRuntimeClock()
    const runtime = new DashboardQueryRuntime({
      now: clock.now,
      timers: clock.timers,
    })

    let value = 0
    const fetcher = vi.fn(async () => ({ value: ++value }))
    const notify = vi.fn()
    const query = {
      key: ['runs:list', { offset: 0 }],
      fetcher,
      tags: ['runs'],
    }

    const stop = runtime.observe(query, notify)
    await flushAsyncWork()

    expect(runtime.getSnapshot<{ value: number }>(query.key).data).toEqual({ value: 1 })

    runtime.invalidateTags(['runs'])
    await flushAsyncWork()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(runtime.getSnapshot<{ value: number }>(query.key).data).toEqual({ value: 2 })

    stop()
    runtime.dispose()
  })

  it('polls active queries with one timer per key', async () => {
    const clock = createManualRuntimeClock()
    const runtime = new DashboardQueryRuntime({
      now: clock.now,
      timers: clock.timers,
    })

    const fetcher = vi.fn(async () => ({ ok: true }))
    const notify = vi.fn()
    const query = {
      key: ['runs:trace', 'chain-1'],
      fetcher,
      tags: ['trace'],
      pollMs: 1000,
    }

    const stopA = runtime.observe(query, notify)
    const stopB = runtime.observe(query, notify)
    await flushAsyncWork()

    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(999)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(1)
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(2)

    stopA()
    stopB()
    runtime.dispose()
  })

  it('coalesces invalidation bursts with a minimum refresh interval', async () => {
    const clock = createManualRuntimeClock()
    const runtime = new DashboardQueryRuntime({
      now: clock.now,
      timers: clock.timers,
    })

    let value = 0
    const fetcher = vi.fn(async () => ({ value: ++value }))
    const notify = vi.fn()
    const query = {
      key: ['runs:list', { offset: 0 }],
      fetcher,
      tags: ['runs'],
      minInvalidationMs: 5_000,
    }

    const stop = runtime.observe(query, notify)
    await flushAsyncWork()

    expect(fetcher).toHaveBeenCalledTimes(1)

    runtime.invalidateTags(['runs'])
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(4_999)
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(1)
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(2)

    stop()
    runtime.dispose()
  })

  it('waits for an invalidation delay before refetching', async () => {
    const clock = createManualRuntimeClock()
    const runtime = new DashboardQueryRuntime({
      now: clock.now,
      timers: clock.timers,
    })

    let value = 0
    const fetcher = vi.fn(async () => ({ value: ++value }))
    const notify = vi.fn()
    const query = {
      key: ['runs:overlay', 'run-1', null],
      fetcher,
      tags: ['overlay:run:run-1'],
      invalidationDelayMs: 150,
    }

    const stop = runtime.observe(query, notify)
    await flushAsyncWork()

    expect(fetcher).toHaveBeenCalledTimes(1)

    runtime.invalidateTags(['overlay:run:run-1'])
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(149)
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(1)

    await clock.advanceBy(1)
    await flushAsyncWork()
    expect(fetcher).toHaveBeenCalledTimes(2)

    stop()
    runtime.dispose()
  })
})
