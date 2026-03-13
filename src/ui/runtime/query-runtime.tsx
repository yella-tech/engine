import { createContext, type ComponentChildren } from 'preact'
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks'
import type { DashboardRuntimeDeps, DashboardTimers, DashboardTimeoutHandle } from './dashboard-deps'
import { useDashboardLiveRuntime } from './dashboard-live'

export type DashboardQueryKeyPart = string | number | boolean | null | undefined | DashboardQueryKeyPart[] | { [key: string]: DashboardQueryKeyPart }

export type DashboardQueryKey = readonly DashboardQueryKeyPart[]

export interface DashboardQuerySnapshot<TData> {
  data: TData | undefined
  error: Error | null
  status: 'idle' | 'loading' | 'success' | 'error'
  isFetching: boolean
  updatedAt: number | null
}

export interface DashboardQueryOptions<TData> {
  key: DashboardQueryKey
  fetcher: () => Promise<TData>
  enabled?: boolean
  pollMs?: number
  tags?: string[]
  minInvalidationMs?: number
  invalidationDelayMs?: number
}

export interface DashboardQueryResult<TData> extends DashboardQuerySnapshot<TData> {
  refetch: () => Promise<TData | undefined>
}

interface DashboardQuerySubscription<TData> {
  fetcher: () => Promise<TData>
  enabled: boolean
  pollMs: number | null
  tags: string[]
  minInvalidationMs: number
  invalidationDelayMs: number
  notify: () => void
}

interface DashboardQueryEntry<TData> {
  keyHash: string
  snapshot: DashboardQuerySnapshot<TData>
  subscriptions: Map<symbol, DashboardQuerySubscription<TData>>
  inFlight: Promise<TData | undefined> | null
  requestVersion: number
  invalidated: boolean
  gcTimer: DashboardTimeoutHandle | null
  pollTimer: DashboardTimeoutHandle | null
  invalidationTimer: DashboardTimeoutHandle | null
  pollMs: number | null
  minInvalidationMs: number
  invalidationDelayMs: number
  tags: Set<string>
  enabled: boolean
  fetcher: (() => Promise<TData>) | null
  lastSettledAt: number | null
}

interface DashboardQueryRuntimeOptions {
  now: () => number
  timers: DashboardTimers
  inactiveGcMs?: number
}

const IDLE_QUERY_SNAPSHOT: DashboardQuerySnapshot<unknown> = {
  data: undefined,
  error: null,
  status: 'idle',
  isFetching: false,
  updatedAt: null,
}

function serializeQueryKey(key: DashboardQueryKey): string {
  return JSON.stringify(key)
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' ? error : 'Unknown query error')
}

export class DashboardQueryRuntime {
  private readonly entries = new Map<string, DashboardQueryEntry<unknown>>()
  private readonly inactiveGcMs: number

  constructor(private readonly options: DashboardQueryRuntimeOptions) {
    this.inactiveGcMs = options.inactiveGcMs ?? 60_000
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.gcTimer !== null) this.options.timers.clearTimeout(entry.gcTimer)
      if (entry.pollTimer !== null) this.options.timers.clearTimeout(entry.pollTimer)
      if (entry.invalidationTimer !== null) this.options.timers.clearTimeout(entry.invalidationTimer)
    }
    this.entries.clear()
  }

  getSnapshot<TData>(key: DashboardQueryKey): DashboardQuerySnapshot<TData> {
    const entry = this.entries.get(serializeQueryKey(key))
    return (entry?.snapshot ?? IDLE_QUERY_SNAPSHOT) as DashboardQuerySnapshot<TData>
  }

  observe<TData>(query: DashboardQueryOptions<TData>, notify: () => void): () => void {
    const entry = this.getOrCreateEntry<TData>(query.key)
    const subscriptionId = Symbol(entry.keyHash)

    if (entry.gcTimer !== null) {
      this.options.timers.clearTimeout(entry.gcTimer)
      entry.gcTimer = null
    }

    entry.subscriptions.set(subscriptionId, {
      fetcher: query.fetcher,
      enabled: query.enabled !== false,
      pollMs: typeof query.pollMs === 'number' && query.pollMs > 0 ? query.pollMs : null,
      tags: query.tags ?? [],
      minInvalidationMs: Math.max(0, query.minInvalidationMs ?? 0),
      invalidationDelayMs: Math.max(0, query.invalidationDelayMs ?? 0),
      notify,
    })

    this.reconcileEntry(entry)

    if (entry.enabled && (entry.invalidated || entry.snapshot.status === 'idle' || (entry.snapshot.status === 'error' && entry.snapshot.updatedAt === null))) {
      void this.fetchEntry(entry)
    }

    return () => {
      const current = this.entries.get(entry.keyHash) as DashboardQueryEntry<TData> | undefined
      if (!current) return
      current.subscriptions.delete(subscriptionId)
      this.reconcileEntry(current)
      if (current.subscriptions.size === 0) {
        this.scheduleGc(current)
      }
    }
  }

  async refetch<TData>(key: DashboardQueryKey): Promise<TData | undefined> {
    const entry = this.entries.get(serializeQueryKey(key)) as DashboardQueryEntry<TData> | undefined
    if (!entry) return undefined
    return this.fetchEntry(entry)
  }

  invalidateTags(tags: string[]) {
    if (tags.length === 0) return
    const invalidationTags = new Set(tags)

    for (const entry of this.entries.values()) {
      const matches = [...entry.tags].some((tag) => invalidationTags.has(tag))
      if (!matches) continue

      entry.invalidated = true
      if (entry.enabled && entry.subscriptions.size > 0) {
        this.scheduleInvalidationFetch(entry)
      }
    }
  }

  private getOrCreateEntry<TData>(key: DashboardQueryKey): DashboardQueryEntry<TData> {
    const keyHash = serializeQueryKey(key)
    const existing = this.entries.get(keyHash)
    if (existing) return existing as DashboardQueryEntry<TData>

    const entry: DashboardQueryEntry<TData> = {
      keyHash,
      snapshot: IDLE_QUERY_SNAPSHOT as DashboardQuerySnapshot<TData>,
      subscriptions: new Map(),
      inFlight: null,
      requestVersion: 0,
      invalidated: false,
      gcTimer: null,
      pollTimer: null,
      invalidationTimer: null,
      pollMs: null,
      minInvalidationMs: 0,
      invalidationDelayMs: 0,
      tags: new Set(),
      enabled: false,
      fetcher: null,
      lastSettledAt: null,
    }
    this.entries.set(keyHash, entry as DashboardQueryEntry<unknown>)
    return entry
  }

  private reconcileEntry<TData>(entry: DashboardQueryEntry<TData>) {
    const subscriptions = [...entry.subscriptions.values()]
    entry.tags = new Set(subscriptions.flatMap((subscription) => subscription.tags))

    const enabledSubscriptions = subscriptions.filter((subscription) => subscription.enabled)
    entry.enabled = enabledSubscriptions.length > 0
    entry.pollMs = enabledSubscriptions.reduce<number | null>((current, subscription) => {
      if (subscription.pollMs === null) return current
      if (current === null) return subscription.pollMs
      return Math.min(current, subscription.pollMs)
    }, null)
    entry.minInvalidationMs = enabledSubscriptions.reduce<number>((current, subscription) => Math.max(current, subscription.minInvalidationMs), 0)
    entry.invalidationDelayMs = enabledSubscriptions.reduce<number>((current, subscription) => Math.max(current, subscription.invalidationDelayMs), 0)

    const activeSubscription = enabledSubscriptions[enabledSubscriptions.length - 1] ?? subscriptions[subscriptions.length - 1] ?? null
    entry.fetcher = activeSubscription?.fetcher ?? null

    if (!entry.enabled && entry.pollTimer !== null) {
      this.options.timers.clearTimeout(entry.pollTimer)
      entry.pollTimer = null
    }

    if (entry.enabled && entry.pollMs === null && entry.pollTimer !== null) {
      this.options.timers.clearTimeout(entry.pollTimer)
      entry.pollTimer = null
    }

    if (!entry.enabled && entry.invalidationTimer !== null) {
      this.options.timers.clearTimeout(entry.invalidationTimer)
      entry.invalidationTimer = null
      return
    }

    if (entry.enabled && entry.pollMs !== null && entry.pollTimer === null && entry.inFlight === null) {
      this.schedulePoll(entry)
    }
  }

  private notifyEntry<TData>(entry: DashboardQueryEntry<TData>) {
    for (const subscription of entry.subscriptions.values()) {
      subscription.notify()
    }
  }

  private scheduleGc<TData>(entry: DashboardQueryEntry<TData>) {
    if (entry.gcTimer !== null) return
    if (entry.pollTimer !== null) {
      this.options.timers.clearTimeout(entry.pollTimer)
      entry.pollTimer = null
    }
    if (entry.invalidationTimer !== null) {
      this.options.timers.clearTimeout(entry.invalidationTimer)
      entry.invalidationTimer = null
    }

    entry.gcTimer = this.options.timers.setTimeout(() => {
      const current = this.entries.get(entry.keyHash) as DashboardQueryEntry<TData> | undefined
      if (!current || current.subscriptions.size > 0) return
      if (current.pollTimer !== null) this.options.timers.clearTimeout(current.pollTimer)
      if (current.invalidationTimer !== null) this.options.timers.clearTimeout(current.invalidationTimer)
      this.entries.delete(entry.keyHash)
    }, this.inactiveGcMs)
  }

  private schedulePoll<TData>(entry: DashboardQueryEntry<TData>) {
    if (entry.pollMs === null || !entry.enabled) return
    if (entry.pollTimer !== null) this.options.timers.clearTimeout(entry.pollTimer)

    entry.pollTimer = this.options.timers.setTimeout(() => {
      entry.pollTimer = null
      void this.fetchEntry(entry)
    }, entry.pollMs)
  }

  private scheduleInvalidationFetch<TData>(entry: DashboardQueryEntry<TData>) {
    const minInvalidationMs = entry.minInvalidationMs
    const sinceLast = entry.lastSettledAt === null ? Number.POSITIVE_INFINITY : this.options.now() - entry.lastSettledAt
    const delayMs = Math.max(entry.invalidationDelayMs, minInvalidationMs - sinceLast, 0)

    if (delayMs === 0 && entry.invalidationTimer === null) {
      void this.fetchEntry(entry)
      return
    }

    if (entry.invalidationTimer !== null) return

    entry.invalidationTimer = this.options.timers.setTimeout(() => {
      entry.invalidationTimer = null
      void this.fetchEntry(entry)
    }, delayMs)
  }

  private async fetchEntry<TData>(entry: DashboardQueryEntry<TData>): Promise<TData | undefined> {
    if (!entry.enabled || !entry.fetcher) return entry.snapshot.data
    if (entry.inFlight) return entry.inFlight

    const hadData = entry.snapshot.updatedAt !== null
    entry.invalidated = false
    entry.requestVersion += 1
    const requestVersion = entry.requestVersion

    if (entry.invalidationTimer !== null) {
      this.options.timers.clearTimeout(entry.invalidationTimer)
      entry.invalidationTimer = null
    }

    entry.snapshot = {
      ...entry.snapshot,
      error: null,
      status: hadData ? 'success' : 'loading',
      isFetching: true,
    }
    this.notifyEntry(entry)

    const inFlight: Promise<TData | undefined> = entry
      .fetcher()
      .then((data) => {
        if (requestVersion !== entry.requestVersion) return data
        entry.snapshot = {
          data,
          error: null,
          status: 'success',
          isFetching: false,
          updatedAt: this.options.now(),
        }
        this.notifyEntry(entry)
        return data
      })
      .catch((error) => {
        if (requestVersion !== entry.requestVersion) return entry.snapshot.data
        entry.snapshot = {
          ...entry.snapshot,
          error: normalizeError(error),
          status: hadData ? 'success' : 'error',
          isFetching: false,
        }
        this.notifyEntry(entry)
        return entry.snapshot.data
      })
      .finally(() => {
        entry.lastSettledAt = this.options.now()
        if (entry.inFlight === inFlight) entry.inFlight = null
        if (entry.invalidated && entry.enabled) {
          this.scheduleInvalidationFetch(entry)
          return
        }
        if (entry.enabled && entry.pollMs !== null) this.schedulePoll(entry)
      })

    entry.inFlight = inFlight
    return inFlight
  }
}

type DashboardQueryContextValue = {
  deps: DashboardRuntimeDeps
  runtime: DashboardQueryRuntime
}

const DashboardQueryContext = createContext<DashboardQueryContextValue | null>(null)

export function DashboardQueryProvider({ deps, children }: { deps: DashboardRuntimeDeps; children: ComponentChildren }) {
  const live = useDashboardLiveRuntime()
  const runtime = useMemo(
    () =>
      new DashboardQueryRuntime({
        now: deps.now,
        timers: deps.timers,
      }),
    [deps.now, deps.timers],
  )

  useEffect(() => {
    return () => {
      runtime.dispose()
    }
  }, [runtime])

  useEffect(() => {
    return live.subscribe((event) => {
      if (event.tags.length > 0) {
        runtime.invalidateTags(event.tags)
      }
    })
  }, [live, runtime])

  const contextValue = useMemo<DashboardQueryContextValue>(() => ({ deps, runtime }), [deps, runtime])

  return <DashboardQueryContext.Provider value={contextValue}>{children}</DashboardQueryContext.Provider>
}

function useDashboardQueryContext() {
  const context = useContext(DashboardQueryContext)
  if (!context) {
    throw new Error('DashboardQueryProvider is required')
  }
  return context
}

export function useDashboardRuntimeDeps() {
  return useDashboardQueryContext().deps
}

export function useDashboardQuery<TData>(query: DashboardQueryOptions<TData>): DashboardQueryResult<TData> {
  const { runtime } = useDashboardQueryContext()
  const [snapshot, setSnapshot] = useState<DashboardQuerySnapshot<TData>>(() => runtime.getSnapshot<TData>(query.key))

  const keyHash = serializeQueryKey(query.key)
  const tagsKey = (query.tags ?? []).join('\u0000')
  const minInvalidationMs = query.minInvalidationMs ?? 0
  const invalidationDelayMs = query.invalidationDelayMs ?? 0

  useEffect(() => {
    setSnapshot(runtime.getSnapshot<TData>(query.key))
    return runtime.observe<TData>(query, () => {
      setSnapshot(runtime.getSnapshot<TData>(query.key))
    })
  }, [runtime, keyHash, query.fetcher, query.enabled, query.pollMs, tagsKey, minInvalidationMs, invalidationDelayMs])

  const refetch = useCallback(() => runtime.refetch<TData>(query.key), [runtime, keyHash])

  return {
    ...snapshot,
    refetch,
  }
}
