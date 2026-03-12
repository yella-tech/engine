import type { ComponentChildren } from 'preact'
import { useState, useCallback, useRef } from 'preact/hooks'
import { Nav, type TabDef } from './Nav'
import { Ticker, TickerMsg } from './Ticker'
import { RunOverlay, type OverlayState, type OverlayActions } from './RunOverlay'
import { Badge } from './Badge'
import { usePolling } from '../hooks/usePolling'
import { useEventStream } from '../hooks/useEventStream'
import { useHashRoute, navigate } from '../hooks/useHashRoute'
import { formatUptime, shortId, timeStr } from '../lib/format'
import { rpc } from '../lib/rpc'
import type { EmitState } from './EmitPanel'
import type { EngineObservabilitySummary, EngineStreamEvent } from '../../types.js'

export interface DashboardConfig {
  brand: string
  tabs: TabDef[]
  renderPanel: (tab: string, ctx: DashboardContext) => ComponentChildren
  onInit?: (ctx: DashboardContext) => void
  includeOverviewObservability?: boolean
}

export interface DashboardContext {
  route: { tab: string; params: Record<string, string> }
  navigate: (path: string) => void
  health: { uptime: string; queue: Record<string, number>; processes: any[] }
  observability: { summary: EngineObservabilitySummary | null }
  recentRuns: { runs: any[]; total: number }
  overlay: OverlayState
  overlayActions: OverlayActions
  emit: EmitState
  setEmit: (s: EmitState | ((prev: EmitState) => EmitState)) => void
  addTicker: (node: ComponentChildren) => void
  overviewRootOnly: boolean
  setOverviewRootOnly: (v: boolean) => void
}

function tickerStatusForEvent(event: EngineStreamEvent): string | null {
  switch (event.eventType) {
    case 'run:start':
      return 'running'
    case 'run:complete':
      return 'completed'
    case 'run:error':
      return 'errored'
    case 'run:dead':
      return 'dead-letter'
    case 'run:retry':
    case 'run:resume':
    case 'lease:reclaim':
      return 'idle'
    default:
      return null
  }
}

function tickerNodeForEvent(event: EngineStreamEvent): ComponentChildren | null {
  const eventType = event.eventType
  if (!eventType) return null

  if (eventType.startsWith('run:') || eventType === 'lease:reclaim') {
    const status = tickerStatusForEvent(event)
    if (!status || !event.eventName || !event.processName) return null
    return (
      <>
        <span class="t-event">{event.eventName}</span> → {event.processName} <Badge state={status} />
      </>
    )
  }

  if (eventType.startsWith('effect:') && event.effectKey) {
    return (
      <>
        effect <span class="t-event">{event.effectKey}</span> {eventType.replace('effect:', '')}
      </>
    )
  }

  if (eventType === 'internal:error' && event.context) {
    return <>internal error: {event.context}</>
  }

  return null
}

export function DashboardShell({ config }: { config: DashboardConfig }) {
  const route = useHashRoute(config.tabs)
  const [health, setHealth] = useState<{ uptime: string; queue: Record<string, number>; processes: any[] }>({ uptime: '--', queue: {}, processes: [] })
  const [observability, setObservability] = useState<{ summary: EngineObservabilitySummary | null }>({ summary: null })
  const [recentRuns, setRecentRuns] = useState<{ runs: any[]; total: number }>({ runs: [], total: 0 })
  const [ticker, setTicker] = useState<ComponentChildren[]>([])
  const [overlay, setOverlay] = useState<OverlayState>({
    open: false,
    runId: null,
    run: null,
    chain: [],
    selectedStepIdx: -1,
    stepDetail: { run: null, effects: [] },
  })
  const [overviewRootOnly, setOverviewRootOnly] = useState(false)
  const [emit, setEmit] = useState<EmitState>({
    eventName: '',
    payload: '{}',
    idempotencyKey: '',
    result: null,
    submitting: false,
    focusPayload: false,
  })

  const healthRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overlayRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const healthFetchInFlightRef = useRef(false)
  const lastHealthRefreshAtRef = useRef(0)

  const addTicker = useCallback((node: ComponentChildren) => {
    setTicker((prev) => {
      const next = [
        <TickerMsg time={timeStr()}>{node}</TickerMsg>,
        ...prev,
      ]
      return next.slice(0, 20)
    })
  }, [])

  const fetchHealth = useCallback(async () => {
    if (healthFetchInFlightRef.current) return
    healthFetchInFlightRef.current = true
    try {
      const shouldFetchOverviewData = route.tab === 'overview'
      const shouldFetchOverviewObservability = shouldFetchOverviewData && config.includeOverviewObservability !== false
      if (shouldFetchOverviewData) {
        const overviewData = await rpc.overview.get({
          limit: 10,
          root: overviewRootOnly || undefined,
          observabilityWindow: shouldFetchOverviewObservability ? '24h' : undefined,
        })
        const healthData = overviewData.health || {}
        const runsData = overviewData.recentRuns || {}
        const observabilityData = overviewData.observability || null

        setHealth({ uptime: formatUptime(healthData.uptime), queue: healthData.queue || {}, processes: healthData.processes || [] })

        const runs = runsData.runs || []
        setRecentRuns({ runs, total: runsData.total ?? runs.length })

        if (shouldFetchOverviewObservability && observabilityData) {
          setObservability({ summary: observabilityData.summary || null })
        }
      } else {
        const healthData = await rpc.health.get()
        setHealth({ uptime: formatUptime(healthData.uptime), queue: healthData.queue || {}, processes: healthData.processes || [] })
      }
    } catch {
      setHealth((prev) => ({ ...prev, uptime: 'offline' }))
    } finally {
      healthFetchInFlightRef.current = false
      lastHealthRefreshAtRef.current = Date.now()
    }
  }, [overviewRootOnly, route.tab, config.includeOverviewObservability])

  const scheduleHealthRefresh = useCallback((delayMs = 250) => {
    if (healthRefreshTimerRef.current) return
    const minIntervalMs = route.tab === 'overview' ? 15_000 : 5_000
    const sinceLast = Date.now() - lastHealthRefreshAtRef.current
    const effectiveDelay = Math.max(delayMs, sinceLast >= minIntervalMs ? 0 : minIntervalMs - sinceLast)
    healthRefreshTimerRef.current = setTimeout(() => {
      healthRefreshTimerRef.current = null
      void fetchHealth()
    }, effectiveDelay)
  }, [fetchHealth, route.tab])

  const healthPollIntervalMs = route.tab === 'overview' ? 300_000 : 60_000
  usePolling(fetchHealth, healthPollIntervalMs, true)

  const applyOverlayPayload = useCallback((runId: string, data: any) => {
    setOverlay((prev) => ({
      ...prev,
      runId,
      run: data.run ?? null,
      chain: data.chain ?? [],
      selectedStepIdx: typeof data.selectedStepIdx === 'number' ? data.selectedStepIdx : 0,
      stepDetail: {
        run: data.selectedRun ?? null,
        effects: data.effects ?? [],
      },
    }))
  }, [])

  // Overlay actions
  const overlayActions: OverlayActions = {
    openOverlay: async (id: string) => {
      setOverlay((prev) => ({ ...prev, open: true, runId: id, run: null, chain: [], selectedStepIdx: -1, stepDetail: { run: null, effects: [] } }))
      try {
        const data = await rpc.runs.overlay(id)
        applyOverlayPayload(id, data)
      } catch {
        setOverlay((prev) => ({ ...prev, run: null, chain: [] }))
      }
    },

    closeOverlay: () => {
      setOverlay((prev) => ({ ...prev, open: false, runId: null }))
    },

    refreshOverlay: async (id: string) => {
      try {
        const selectedId = overlay.stepDetail.run?.id ?? overlay.chain[overlay.selectedStepIdx]?.id ?? undefined
        const data = await rpc.runs.overlay(id, selectedId ? { selectedId } : undefined)
        applyOverlayPayload(id, data)
      } catch {}
    },

    selectStep: async (idx: number) => {
      setOverlay((prev) => ({ ...prev, selectedStepIdx: idx, stepDetail: { run: null, effects: [] } }))
      const selectedId = overlay.chain[idx]?.id
      if (!overlay.runId || !selectedId) return
      try {
        const data = await rpc.runs.overlay(overlay.runId, { selectedId })
        applyOverlayPayload(overlay.runId, data)
      } catch {}
    },

    retryStep: async (runId: string) => {
      try {
        const data = await rpc.runs.retry(runId)
        addTicker(
          <>
            retried <span class="t-event">{shortId(runId)}</span> → <Badge state={data.status || data.state} />
          </>,
        )
        setOverlay((prev) => {
          if (prev.runId) overlayActions.refreshOverlay(prev.runId)
          return prev
        })
      } catch (err: any) {
        addTicker(<>retry failed: {err.message || 'unknown error'}</>)
      }
    },

    requeueStep: async (runId: string) => {
      try {
        const data = await rpc.runs.requeue(runId)
        addTicker(
          <>
            requeued <span class="t-event">{shortId(runId)}</span> → <Badge state={data.status || data.state} />
          </>,
        )
        setOverlay((prev) => {
          if (prev.runId) overlayActions.refreshOverlay(prev.runId)
          return prev
        })
      } catch (err: any) {
        addTicker(<>requeue failed: {err.message || 'unknown error'}</>)
      }
    },

    reemitStep: (eventName: string, payload: unknown) => {
      overlayActions.closeOverlay()
      navigate('/emit')
      setEmit({
        eventName,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
        idempotencyKey: '',
        result: null,
        submitting: false,
        focusPayload: true,
      })
    },

    resumeStep: async (runId: string) => {
      try {
        const data = await rpc.runs.resume(runId)
        addTicker(
          <>
            resumed <span class="t-event">{shortId(runId)}</span> → {data.runs?.length ?? 0} run(s) created
          </>,
        )
        setTimeout(() => {
          if (overlay.runId) overlayActions.refreshOverlay(overlay.runId)
        }, 500)
      } catch (err: any) {
        addTicker(<>resume failed: {err.message || 'unknown error'}</>)
      }
    },

    viewInTrace: (rootId: string) => {
      overlayActions.closeOverlay()
      navigate(`/trace/${rootId}`)
    },

    viewInGraph: (rootId: string) => {
      overlayActions.closeOverlay()
      navigate(`/graph/${rootId}`)
    },
  }

  const scheduleOverlayRefresh = useCallback((delayMs = 150) => {
    if (overlayRefreshTimerRef.current || !overlay.runId) return
    overlayRefreshTimerRef.current = setTimeout(() => {
      overlayRefreshTimerRef.current = null
      if (overlay.runId) {
        void overlayActions.refreshOverlay(overlay.runId)
      }
    }, delayMs)
  }, [overlay.runId, overlayActions])

  useEventStream<EngineStreamEvent>(
    '/events',
    (event) => {
      if (event.kind !== 'event') return
      const tickerNode = tickerNodeForEvent(event)
      if (tickerNode) {
        addTicker(tickerNode)
      }

      if (route.tab === 'overview' && (event.topics.includes('health') || event.topics.includes('overview') || event.topics.includes('runs'))) {
        scheduleHealthRefresh()
      }

      if (!overlay.open || !overlay.run) return
      if (event.topics.includes('overlay') || event.topics.includes('trace')) {
        const sameRun = !!event.runId && overlay.chain.some((step: any) => step.id === event.runId)
        const sameCorrelation = !!event.correlationId && event.correlationId === overlay.run.correlationId
        if (sameRun || sameCorrelation) {
          scheduleOverlayRefresh()
        }
      }
    },
    true,
  )

  const ctx: DashboardContext = {
    route,
    navigate,
    health,
    observability,
    recentRuns,
    overlay,
    overlayActions,
    emit,
    setEmit,
    addTicker,
    overviewRootOnly,
    setOverviewRootOnly,
  }

  return (
    <>
      <Nav brand={config.brand} tabs={config.tabs} uptime={health.uptime} />

      <div class="dashboard-main">{config.renderPanel(route.tab, ctx)}</div>

      <Ticker messages={ticker} />
      <RunOverlay overlay={overlay} actions={overlayActions} />
    </>
  )
}
