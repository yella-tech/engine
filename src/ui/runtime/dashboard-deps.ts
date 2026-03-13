import { subscribeToJsonEventStream } from '../hooks/useEventStream'
import { navigate } from '../hooks/useHashRoute'
import { rpc, type EngineRpcClient } from '../lib/rpc'
import type { EngineStreamEvent } from '../../types.js'

export type DashboardTimeoutHandle = ReturnType<typeof globalThis.setTimeout>

export interface DashboardRuntimeRpc {
  emit: Pick<EngineRpcClient['emit'], 'post'>
  health: Pick<EngineRpcClient['health'], 'get'>
  overview: Pick<EngineRpcClient['overview'], 'get'>
  graph: Pick<EngineRpcClient['graph'], 'get'>
  runs: Pick<EngineRpcClient['runs'], 'list' | 'chain' | 'overlay' | 'trace' | 'retry' | 'requeue' | 'resume'>
}

export interface DashboardTimers {
  setTimeout: (callback: () => void, delayMs: number) => DashboardTimeoutHandle
  clearTimeout: (handle: DashboardTimeoutHandle) => void
}

export interface DashboardLiveSource<TEvent = unknown> {
  subscribe: (listener: (event: TEvent) => void) => () => void
}

export interface DashboardRuntimeDeps {
  rpc: DashboardRuntimeRpc
  navigate: (path: string) => void
  now: () => number
  timers: DashboardTimers
  live: DashboardLiveSource<EngineStreamEvent>
}

export const defaultDashboardRuntimeDeps: DashboardRuntimeDeps = {
  rpc,
  navigate,
  now: () => Date.now(),
  timers: {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  },
  live: {
    subscribe: (listener) => subscribeToJsonEventStream('/events', listener),
  },
}

export function createDashboardRuntimeDeps(overrides: Partial<DashboardRuntimeDeps> = {}): DashboardRuntimeDeps {
  return {
    ...defaultDashboardRuntimeDeps,
    ...overrides,
    timers: overrides.timers ?? defaultDashboardRuntimeDeps.timers,
    live: overrides.live ?? defaultDashboardRuntimeDeps.live,
  }
}
