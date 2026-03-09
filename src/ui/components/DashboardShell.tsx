import type { ComponentChildren } from 'preact'
import { useState, useCallback, useRef } from 'preact/hooks'
import { Nav, type TabDef } from './Nav'
import { Ticker, TickerMsg } from './Ticker'
import { RunOverlay, type OverlayState, type OverlayActions } from './RunOverlay'
import { Badge } from './Badge'
import { usePolling } from '../hooks/usePolling'
import { useHashRoute, navigate } from '../hooks/useHashRoute'
import { api } from '../lib/api'
import { formatUptime, formatJson, shortId, timeStr } from '../lib/format'
import type { EmitState } from './EmitPanel'

export interface DashboardConfig {
  brand: string
  tabs: TabDef[]
  renderPanel: (tab: string, ctx: DashboardContext) => ComponentChildren
  onInit?: (ctx: DashboardContext) => void
}

export interface DashboardContext {
  route: { tab: string; params: Record<string, string> }
  navigate: (path: string) => void
  health: { uptime: string; queue: Record<string, number>; processes: any[] }
  recentRuns: { runs: any[]; total: number }
  overlay: OverlayState
  overlayActions: OverlayActions
  emit: EmitState
  setEmit: (s: EmitState | ((prev: EmitState) => EmitState)) => void
  addTicker: (node: ComponentChildren) => void
}

export function DashboardShell({ config }: { config: DashboardConfig }) {
  const route = useHashRoute(config.tabs)
  const [health, setHealth] = useState<{ uptime: string; queue: Record<string, number>; processes: any[] }>({ uptime: '--', queue: {}, processes: [] })
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
  const [emit, setEmit] = useState<EmitState>({
    eventName: '',
    payload: '{}',
    idempotencyKey: '',
    result: null,
    submitting: false,
    focusPayload: false,
  })

  const lastSnapRef = useRef('')

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
    try {
      const data = await api('/health')
      setHealth({ uptime: formatUptime(data.uptime), queue: data.queue || {}, processes: data.processes || [] })

      const runsData = await api('/runs?limit=10')
      const runs = runsData.runs || []
      setRecentRuns({ runs, total: runsData.total ?? runs.length })

      const snap = JSON.stringify(runs.map((r: any) => r.id + r.state))
      if (lastSnapRef.current && snap !== lastSnapRef.current) {
        const newRuns = runs.filter((r: any) => !lastSnapRef.current.includes(r.id))
        newRuns.forEach((r: any) => {
          addTicker(
            <>
              <span class="t-event">{r.eventName}</span> → {r.processName} <Badge state={r.state} />
            </>,
          )
        })
      }
      lastSnapRef.current = snap
    } catch {
      setHealth((prev) => ({ ...prev, uptime: 'offline' }))
    }
  }, [addTicker])

  usePolling(fetchHealth, 2000, true)

  // Overlay actions
  const overlayActions: OverlayActions = {
    openOverlay: async (id: string) => {
      setOverlay((prev) => ({ ...prev, open: true, runId: id, run: null, chain: [], selectedStepIdx: -1, stepDetail: { run: null, effects: [] } }))
      try {
        let run = await api('/runs/' + id)
        let rootId = id
        while (run.parentRunId) {
          rootId = run.parentRunId
          run = await api('/runs/' + rootId)
        }
        const chainData = await api('/runs/' + rootId + '/chain')
        const chain = (chainData.runs || []).sort((a: any, b: any) => (a.depth ?? 0) - (b.depth ?? 0) || a.startedAt - b.startedAt)
        const clickedRun = chain.find((c: any) => c.id === id) || run
        const clickedIdx = chain.findIndex((c: any) => c.id === id)
        const idx = clickedIdx >= 0 ? clickedIdx : 0
        setOverlay((prev) => ({ ...prev, run: clickedRun, chain, selectedStepIdx: idx }))
        if (chain[idx]) {
          const [stepRun, effectsData] = await Promise.all([api('/runs/' + chain[idx].id), api('/runs/' + chain[idx].id + '/effects')])
          setOverlay((prev) => ({ ...prev, stepDetail: { run: stepRun, effects: effectsData.effects || [] } }))
        }
      } catch {
        setOverlay((prev) => ({ ...prev, run: null, chain: [] }))
      }
    },

    closeOverlay: () => {
      setOverlay((prev) => ({ ...prev, open: false, runId: null }))
    },

    refreshOverlay: async (id: string) => {
      try {
        let run = await api('/runs/' + id)
        let rootId = id
        while (run.parentRunId) {
          rootId = run.parentRunId
          run = await api('/runs/' + rootId)
        }
        const chainData = await api('/runs/' + rootId + '/chain')
        const chain = (chainData.runs || []).sort((a: any, b: any) => (a.depth ?? 0) - (b.depth ?? 0) || a.startedAt - b.startedAt)
        const clickedRun = chain.find((c: any) => c.id === id) || run
        setOverlay((prev) => ({ ...prev, run: clickedRun, chain }))
        setOverlay((prev) => {
          const step = prev.chain[prev.selectedStepIdx]
          if (step) {
            Promise.all([api('/runs/' + step.id), api('/runs/' + step.id + '/effects')]).then(([stepRun, effectsData]) => {
              setOverlay((p) => ({ ...p, stepDetail: { run: stepRun, effects: effectsData.effects || [] } }))
            })
          }
          return prev
        })
      } catch {}
    },

    selectStep: async (idx: number) => {
      setOverlay((prev) => ({ ...prev, selectedStepIdx: idx, stepDetail: { run: null, effects: [] } }))
      setOverlay((prev) => {
        const step = prev.chain[idx]
        if (step) {
          Promise.all([api('/runs/' + step.id), api('/runs/' + step.id + '/effects')]).then(([stepRun, effectsData]) => {
            setOverlay((p) => ({ ...p, stepDetail: { run: stepRun, effects: effectsData.effects || [] } }))
          })
        }
        return prev
      })
    },

    retryStep: async (runId: string) => {
      try {
        const data = await api('/runs/' + runId + '/retry', { method: 'POST' })
        addTicker(
          <>
            retried <span class="t-event">{shortId(runId)}</span> → <Badge state={data.state} />
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
        const data = await api('/runs/' + runId + '/requeue', { method: 'POST' })
        addTicker(
          <>
            requeued <span class="t-event">{shortId(runId)}</span> → <Badge state={data.state} />
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

    viewInTrace: (rootId: string) => {
      overlayActions.closeOverlay()
      navigate(`/trace/${rootId}`)
    },

    viewInGraph: (rootId: string) => {
      overlayActions.closeOverlay()
      navigate(`/graph/${rootId}`)
    },
  }

  const ctx: DashboardContext = {
    route,
    navigate,
    health,
    recentRuns,
    overlay,
    overlayActions,
    emit,
    setEmit,
    addTicker,
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
