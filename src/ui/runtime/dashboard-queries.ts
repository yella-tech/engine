import { useCallback } from 'preact/hooks'
import type { DashboardRuntimeRpc } from './dashboard-deps'
import { useDashboardQuery, useDashboardRuntimeDeps } from './query-runtime'

type RunsListResult = Awaited<ReturnType<DashboardRuntimeRpc['runs']['list']>>
type TraceResult = Awaited<ReturnType<DashboardRuntimeRpc['runs']['trace']>>
type ChainResult = Awaited<ReturnType<DashboardRuntimeRpc['runs']['chain']>>
type GraphResult = Awaited<ReturnType<DashboardRuntimeRpc['graph']['get']>>
type HealthResult = Awaited<ReturnType<DashboardRuntimeRpc['health']['get']>>
type OverviewResult = Awaited<ReturnType<DashboardRuntimeRpc['overview']['get']>>
type OverlayResult = Awaited<ReturnType<DashboardRuntimeRpc['runs']['overlay']>>

export function useRunsListQuery(params: { limit: number; offset?: number; status?: string; root?: boolean; pollMs?: number; enabled?: boolean }) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(
    () =>
      rpc.runs.list({
        limit: params.limit,
        offset: params.offset,
        status: params.status,
        root: params.root,
      }),
    [params.limit, params.offset, params.root, params.status, rpc],
  )

  return useDashboardQuery<RunsListResult>({
    key: ['runs:list', { limit: params.limit, offset: params.offset ?? 0, status: params.status ?? null, root: !!params.root }],
    fetcher,
    enabled: params.enabled,
    pollMs: params.pollMs,
    tags: ['runs'],
    minInvalidationMs: 5_000,
  })
}

export function useHealthQuery(enabled = true) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(() => rpc.health.get(), [rpc])

  return useDashboardQuery<HealthResult>({
    key: ['health'],
    fetcher,
    enabled,
    tags: ['health', 'runs'],
    minInvalidationMs: 5_000,
    invalidationDelayMs: 250,
  })
}

export function useOverviewQuery(params: { limit?: number; root?: boolean; observabilityWindow?: string }, enabled = true, pollMs?: number) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(
    () =>
      rpc.overview.get({
        limit: params.limit,
        root: params.root,
        observabilityWindow: params.observabilityWindow,
      }),
    [params.limit, params.observabilityWindow, params.root, rpc],
  )

  return useDashboardQuery<OverviewResult>({
    key: ['overview', { limit: params.limit ?? null, root: !!params.root, observabilityWindow: params.observabilityWindow ?? null }],
    fetcher,
    enabled,
    pollMs,
    tags: ['overview', 'health', 'runs', ...(params.observabilityWindow ? ['observability'] : [])],
    minInvalidationMs: 5_000,
    invalidationDelayMs: 250,
  })
}

export function useRootRunsQuery(limit = 100) {
  return useRunsListQuery({
    limit,
    root: true,
  })
}

export function useOverlayQuery(runId?: string, selectedId?: string, fallbackSelectedId?: string, correlationId?: string | null) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(() => {
    const resolvedSelectedId = selectedId ?? fallbackSelectedId
    return rpc.runs.overlay(runId!, resolvedSelectedId ? { selectedId: resolvedSelectedId } : undefined)
  }, [fallbackSelectedId, rpc, runId, selectedId])
  const tags = runId ? [`overlay:run:${runId}`] : []
  if (correlationId) tags.push(`overlay:correlation:${correlationId}`)

  return useDashboardQuery<OverlayResult>({
    key: ['runs:overlay', runId ?? null, selectedId ?? null],
    fetcher,
    enabled: !!runId,
    tags,
    invalidationDelayMs: 150,
  })
}

export function useTraceQuery(chainId?: string, pollMs = 10_000) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(() => rpc.runs.trace(chainId!), [chainId, rpc])

  return useDashboardQuery<TraceResult>({
    key: ['runs:trace', chainId ?? null],
    fetcher,
    enabled: !!chainId,
    pollMs: chainId ? pollMs : undefined,
    tags: ['trace'],
  })
}

export function useGraphQuery() {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(() => rpc.graph.get(), [rpc])

  return useDashboardQuery<GraphResult>({
    key: ['graph:static'],
    fetcher,
    tags: ['graph'],
  })
}

export function useChainRunsQuery(chainId?: string, pollMs = 10_000) {
  const { rpc } = useDashboardRuntimeDeps()
  const fetcher = useCallback(() => rpc.runs.chain(chainId!), [chainId, rpc])

  return useDashboardQuery<ChainResult>({
    key: ['runs:chain', chainId ?? null],
    fetcher,
    enabled: !!chainId,
    pollMs: chainId ? pollMs : undefined,
    tags: ['chain'],
  })
}
