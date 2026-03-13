// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardConfig, DashboardContext } from './DashboardShell'
import { DashboardShell } from './DashboardShell'
import { EmitPanel } from './EmitPanel'
import { icons } from './Nav'
import { createDashboardRuntimeDeps, type DashboardRuntimeRpc, type DashboardTimers } from '../runtime/dashboard-deps'
import type { EngineStreamEvent } from '../../types.js'

function makeHealth() {
  return {
    queue: {},
    processes: [],
    uptime: 12,
  }
}

function makeOverview() {
  return {
    health: makeHealth(),
    recentRuns: {
      runs: [],
      total: 0,
    },
    observability: {
      summary: null,
    },
  }
}

function makeRun(runId: string, processName = runId, overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    processName,
    eventName: `${processName}:event`,
    state: 'completed',
    status: 'completed',
    correlationId: `corr-${runId}`,
    parentRunId: null,
    payload: { ok: true },
    result: { success: true },
    context: {},
    ...overrides,
  }
}

function makeOverlayPayload(runId: string, processName = runId, runOverrides: Record<string, unknown> = {}) {
  const run = makeRun(runId, processName, runOverrides)
  return {
    run,
    chain: [run],
    selectedStepIdx: 0,
    selectedRun: run,
    effects: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createLiveController() {
  const listeners = new Set<(event: EngineStreamEvent) => void>()
  let subscribeCount = 0

  return {
    live: {
      subscribe: (next: (event: EngineStreamEvent) => void) => {
        subscribeCount += 1
        listeners.add(next)
        return () => {
          listeners.delete(next)
        }
      },
    },
    getSubscribeCount() {
      return subscribeCount
    },
    getActiveSubscriberCount() {
      return listeners.size
    },
    emit(event: EngineStreamEvent) {
      for (const listener of listeners) {
        listener(event)
      }
    },
  }
}

function createManualClock() {
  let now = 0
  let nextId = 1
  const tasks = new Map<number, { at: number; callback: () => void }>()

  const runDueTasks = () => {
    while (true) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= now)
        .sort((left, right) => left[1].at - right[1].at)

      if (due.length === 0) return

      for (const [id, task] of due) {
        tasks.delete(id)
        task.callback()
      }
    }
  }

  const timers: DashboardTimers = {
    setTimeout: (callback, delayMs) => {
      const id = nextId++
      tasks.set(id, { at: now + delayMs, callback })
      return id as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as unknown as number)
    },
  }

  return {
    timers,
    now: () => now,
    setNow(value: number) {
      now = value
    },
    async advanceBy(delayMs: number) {
      now += delayMs
      runDueTasks()
      await Promise.resolve()
    },
  }
}

function createRpc(overrides: Partial<{
  emitPost: DashboardRuntimeRpc['emit']['post']
  healthGet: DashboardRuntimeRpc['health']['get']
  overviewGet: DashboardRuntimeRpc['overview']['get']
  graphGet: DashboardRuntimeRpc['graph']['get']
  list: DashboardRuntimeRpc['runs']['list']
  trace: DashboardRuntimeRpc['runs']['trace']
  chain: DashboardRuntimeRpc['runs']['chain']
  overlay: DashboardRuntimeRpc['runs']['overlay']
  retry: DashboardRuntimeRpc['runs']['retry']
  requeue: DashboardRuntimeRpc['runs']['requeue']
  resume: DashboardRuntimeRpc['runs']['resume']
}> = {}): DashboardRuntimeRpc {
  return {
    emit: {
      post: (overrides.emitPost ?? vi.fn(async () => ({ created: 1 }))) as DashboardRuntimeRpc['emit']['post'],
    },
    health: {
      get: (overrides.healthGet ?? vi.fn(async () => makeHealth())) as DashboardRuntimeRpc['health']['get'],
    },
    overview: {
      get: (overrides.overviewGet ?? vi.fn(async () => makeOverview())) as DashboardRuntimeRpc['overview']['get'],
    },
    graph: {
      get: (overrides.graphGet ?? vi.fn(async () => ({ nodes: [], edges: [] }))) as DashboardRuntimeRpc['graph']['get'],
    },
    runs: {
      list: (overrides.list ?? vi.fn(async () => ({ runs: [], total: 0 }))) as DashboardRuntimeRpc['runs']['list'],
      trace: (overrides.trace ?? vi.fn(async () => ({ spans: [] }))) as DashboardRuntimeRpc['runs']['trace'],
      chain: (overrides.chain ?? vi.fn(async () => ({ runs: [] }))) as DashboardRuntimeRpc['runs']['chain'],
      overlay: (overrides.overlay ?? vi.fn(async (runId: string) => makeOverlayPayload(runId))) as DashboardRuntimeRpc['runs']['overlay'],
      retry: (overrides.retry ?? vi.fn(async () => ({ status: 'idle' }))) as DashboardRuntimeRpc['runs']['retry'],
      requeue: (overrides.requeue ?? vi.fn(async () => ({ status: 'idle' }))) as DashboardRuntimeRpc['runs']['requeue'],
      resume: (overrides.resume ?? vi.fn(async () => ({ runs: [] }))) as DashboardRuntimeRpc['runs']['resume'],
    },
  }
}

function createConfig(renderPanel: DashboardConfig['renderPanel'], options: Partial<Pick<DashboardConfig, 'includeOverviewObservability'>> = {}): DashboardConfig {
  return {
    brand: 'TEST',
    tabs: [
      { id: 'overview', label: 'Overview', icon: icons.overview, path: '/' },
      { id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' },
    ],
    renderPanel,
    ...options,
  }
}

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('DashboardShell', () => {
  it('preserves the current DashboardConfig and DashboardContext compatibility surface', async () => {
    window.location.hash = '#/'

    const navigate = vi.fn()
    const overviewGet = vi.fn(async () => makeOverview())
    let latestContext: DashboardContext | null = null

    const live = createLiveController()
    const runtimeDeps = createDashboardRuntimeDeps({
      rpc: createRpc({ overviewGet }),
      navigate,
      live: live.live,
    })

    render(
      <DashboardShell
        config={createConfig(
          (tab, ctx) => {
            latestContext = ctx
            return (
              <div>
                <div data-testid="tab">{tab}</div>
                <button onClick={() => ctx.navigate('/runs')}>Go Runs</button>
              </div>
            )
          },
          { includeOverviewObservability: false },
        )}
        runtimeDeps={runtimeDeps}
      />,
    )

    await waitFor(() => expect(overviewGet).toHaveBeenCalledTimes(1))

    expect(overviewGet).toHaveBeenCalledWith({
      limit: 10,
      root: undefined,
      observabilityWindow: undefined,
    })

    expect(screen.getByTestId('tab').textContent).toBe('overview')

    const overviewLink = screen.getByRole('link', { name: /overview/i })
    expect(overviewLink.getAttribute('class') || '').toContain('active')

    expect(latestContext?.route.tab).toBe('overview')
    expect(latestContext?.route.path).toBe('/')
    expect(typeof latestContext?.navigate).toBe('function')
    expect(typeof latestContext?.overlayActions.openOverlay).toBe('function')
    expect(typeof latestContext?.setEmit).toBe('function')
    expect(typeof latestContext?.submitEmit).toBe('function')
    expect(typeof latestContext?.addTicker).toBe('function')
    expect(latestContext?.overviewRootOnly).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Go Runs' }))
    expect(navigate).toHaveBeenCalledWith('/runs')
  })

  it('ignores stale overlay responses when the selected run changes quickly', async () => {
    window.location.hash = '#/runs'

    const overlayA = deferred<ReturnType<typeof makeOverlayPayload>>()
    const overlayB = deferred<ReturnType<typeof makeOverlayPayload>>()
    const overlay = vi.fn((runId: string) => {
      if (runId === 'run-a') return overlayA.promise
      if (runId === 'run-b') return overlayB.promise
      return Promise.resolve(makeOverlayPayload(runId))
    })

    render(
      <DashboardShell
        config={createConfig((tab, ctx) => {
          if (tab !== 'runs') return <div>{tab}</div>
          return (
            <div>
              <button onClick={() => ctx.overlayActions.openOverlay('run-a')}>Open Run A</button>
              <button onClick={() => ctx.overlayActions.openOverlay('run-b')}>Open Run B</button>
            </div>
          )
        })}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overlay }),
          live: createLiveController().live,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Run A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Run B' }))

    await waitFor(() => expect(overlay).toHaveBeenCalledTimes(2))

    await act(async () => {
      overlayB.resolve(makeOverlayPayload('run-b', 'process-b'))
      await overlayB.promise
    })

    await screen.findByText('process-b:event')

    await act(async () => {
      overlayA.resolve(makeOverlayPayload('run-a', 'process-a'))
      await overlayA.promise
    })

    expect(screen.getByText('process-b:event')).toBeTruthy()
    expect(screen.queryByText('process-a:event')).toBeNull()
  })

  it('retries the selected errored step and refreshes the active overlay', async () => {
    window.location.hash = '#/runs'

    const runId = 'run-retry'
    const overlay = vi.fn(async (requestedRunId: string, options?: { selectedId?: string }) => {
      expect(requestedRunId).toBe(runId)
      return makeOverlayPayload(runId, 'retry-process', {
        state: 'errored',
        status: 'errored',
        result: { error: { message: 'boom' } },
        selectedId: options?.selectedId,
      })
    })
    const retry = vi.fn(async () => ({ status: 'idle' }))

    render(
      <DashboardShell
        config={createConfig((tab, ctx) => {
          if (tab !== 'runs') return <div>{tab}</div>
          return <button onClick={() => ctx.overlayActions.openOverlay(runId)}>Open Retry Run</button>
        })}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overlay, retry }),
          live: createLiveController().live,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Retry Run' }))

    await screen.findByRole('button', { name: 'Retry' })
    expect(overlay).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(retry).toHaveBeenCalledWith(runId))
    await waitFor(() => expect(overlay).toHaveBeenCalledTimes(2))
    expect(overlay.mock.calls[1]).toEqual([runId, undefined])
  })

  it('requeues a dead-letter step and refreshes the active overlay', async () => {
    window.location.hash = '#/runs'

    const runId = 'run-requeue'
    const overlay = vi.fn(async (requestedRunId: string, options?: { selectedId?: string }) => {
      expect(requestedRunId).toBe(runId)
      return makeOverlayPayload(runId, 'requeue-process', {
        state: 'errored',
        status: 'dead-letter',
        result: { error: { message: 'still broken' } },
        selectedId: options?.selectedId,
      })
    })
    const requeue = vi.fn(async () => ({ status: 'idle' }))

    render(
      <DashboardShell
        config={createConfig((tab, ctx) => {
          if (tab !== 'runs') return <div>{tab}</div>
          return <button onClick={() => ctx.overlayActions.openOverlay(runId)}>Open Dead-Letter Run</button>
        })}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overlay, requeue }),
          live: createLiveController().live,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Dead-Letter Run' }))

    await screen.findByRole('button', { name: 'Requeue' })
    expect(overlay).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }))

    await waitFor(() => expect(requeue).toHaveBeenCalledWith(runId))
    await waitFor(() => expect(overlay).toHaveBeenCalledTimes(2))
    expect(overlay.mock.calls[1]).toEqual([runId, undefined])
  })

  it('resumes a deferred step and refreshes the latest open overlay after the delay', async () => {
    window.location.hash = '#/runs'

    const clock = createManualClock()
    const deferredRunId = 'run-deferred'
    const latestRunId = 'run-latest'
    const overlay = vi.fn(async (runId: string) => {
      if (runId === deferredRunId) {
        return makeOverlayPayload(deferredRunId, 'approval-process', {
          state: 'completed',
          status: 'deferred',
          result: { success: true, triggerEvent: 'approval:granted', deferred: true },
        })
      }

      return makeOverlayPayload(latestRunId, 'latest-process')
    })
    const resume = vi.fn(async () => ({ runs: [{ id: 'resumed-run-1' }] }))

    render(
      <DashboardShell
        config={createConfig((tab, ctx) => {
          if (tab !== 'runs') return <div>{tab}</div>
          return (
            <div>
              <button onClick={() => ctx.overlayActions.openOverlay(deferredRunId)}>Open Deferred Run</button>
              <button onClick={() => ctx.overlayActions.openOverlay(latestRunId)}>Open Latest Run</button>
            </div>
          )
        })}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overlay, resume }),
          now: clock.now,
          timers: clock.timers,
          live: createLiveController().live,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Deferred Run' }))
    await screen.findByRole('button', { name: /resume/i })
    expect(overlay).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /resume/i }))
    await waitFor(() => expect(resume).toHaveBeenCalledWith(deferredRunId))

    fireEvent.click(screen.getByRole('button', { name: 'Open Latest Run' }))
    await screen.findByText('latest-process:event')
    expect(overlay).toHaveBeenCalledTimes(2)

    await act(async () => {
      await clock.advanceBy(499)
    })
    expect(overlay).toHaveBeenCalledTimes(2)

    await act(async () => {
      await clock.advanceBy(1)
    })

    await waitFor(() => expect(overlay).toHaveBeenCalledTimes(3))
    expect(overlay.mock.calls[2]).toEqual([latestRunId, undefined])
  })

  it('refreshes overview data from live invalidation events through the query runtime', async () => {
    window.location.hash = '#/'

    const clock = createManualClock()
    const live = createLiveController()
    const overviewGet = vi.fn(async () => makeOverview())

    render(
      <DashboardShell
        config={createConfig((tab) => <div>{tab}</div>)}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overviewGet }),
          now: clock.now,
          timers: clock.timers,
          live: live.live,
        })}
      />,
    )

    await waitFor(() => expect(overviewGet).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(live.getSubscribeCount()).toBe(1))
    const initialCallCount = overviewGet.mock.calls.length

    clock.setNow(6_000)
    act(() => {
      live.emit({
        kind: 'event',
        at: 6_000,
        topics: ['health'],
      })
    })

    await act(async () => {
      await clock.advanceBy(249)
    })
    expect(overviewGet).toHaveBeenCalledTimes(initialCallCount)

    await act(async () => {
      await clock.advanceBy(1)
    })

    await waitFor(() => expect(overviewGet).toHaveBeenCalledTimes(initialCallCount + 1))
  })

  it('uses one live subscription and refreshes the active overlay only for matching live events', async () => {
    window.location.hash = '#/runs'

    const clock = createManualClock()
    const live = createLiveController()
    const runId = 'run-live'
    const overlay = vi.fn(async (requestedRunId: string) => {
      expect(requestedRunId).toBe(runId)
      return makeOverlayPayload(runId, 'live-process')
    })

    render(
      <DashboardShell
        config={createConfig((tab, ctx) => {
          if (tab !== 'runs') return <div>{tab}</div>
          return <button onClick={() => ctx.overlayActions.openOverlay(runId)}>Open Live Run</button>
        })}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ overlay }),
          now: clock.now,
          timers: clock.timers,
          live: live.live,
        })}
      />,
    )

    await waitFor(() => expect(live.getSubscribeCount()).toBe(1))
    expect(live.getActiveSubscriberCount()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open Live Run' }))
    await screen.findByText('live-process:event')
    expect(overlay).toHaveBeenCalledTimes(1)

    act(() => {
      live.emit({
        kind: 'event',
        at: 0,
        topics: ['overlay'],
        runId: 'other-run',
        correlationId: 'other-correlation',
      })
    })

    await act(async () => {
      await clock.advanceBy(150)
    })
    expect(overlay).toHaveBeenCalledTimes(1)

    act(() => {
      live.emit({
        kind: 'event',
        at: 151,
        topics: ['overlay'],
        runId,
      })
    })

    await act(async () => {
      await clock.advanceBy(149)
    })
    expect(overlay).toHaveBeenCalledTimes(1)

    await act(async () => {
      await clock.advanceBy(1)
    })

    await waitFor(() => expect(overlay).toHaveBeenCalledTimes(2))
  })

  it('submits emits through the runtime context', async () => {
    window.location.hash = '#/emit'

    const emitPost = vi.fn(async () => ({ created: 2 }))

    render(
      <DashboardShell
        config={{
          brand: 'TEST',
          tabs: [{ id: 'emit', label: 'Emit', icon: icons.emit, path: '/emit' }],
          renderPanel: (tab, ctx) => {
            if (tab !== 'emit') return null
            return <EmitPanel emit={ctx.emit} onUpdate={(patch) => ctx.setEmit((prev) => ({ ...prev, ...patch }))} onSubmit={() => void ctx.submitEmit()} />
          },
        }}
        runtimeDeps={createDashboardRuntimeDeps({
          rpc: createRpc({ emitPost }),
          live: createLiveController().live,
        })}
      />,
    )

    const textboxes = screen.getAllByRole('textbox')
    fireEvent.input(screen.getByPlaceholderText('e.g. email:new'), { target: { value: 'demo:event' } })
    fireEvent.input(textboxes[1], { target: { value: '{"ok":true}' } })
    fireEvent.input(screen.getByPlaceholderText('leave empty for none'), { target: { value: 'abc-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Emit Event' }))

    await waitFor(() =>
      expect(emitPost).toHaveBeenCalledWith({
        event: 'demo:event',
        payload: { ok: true },
        idempotencyKey: 'abc-123',
      }),
    )

    await screen.findByText(/"created": 2/)
  })
})
