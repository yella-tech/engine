import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Badge } from '../components/Badge'
import { type OverlayActions, type OverlayState } from '../components/RunOverlay'
import type { EmitState } from '../components/EmitPanel'
import { TickerMsg } from '../components/Ticker'
import { useHashRoute } from '../hooks/useHashRoute'
import { formatJson, shortId, timeStr } from '../lib/format'
import type { DashboardConfig, DashboardContext } from './dashboard-types'
import { defaultDashboardRuntimeDeps, type DashboardRuntimeDeps, type DashboardTimers } from './dashboard-deps'
import { tickerNodeForStreamEvent, useDashboardLiveSubscription } from './dashboard-live'
import { useHealthQuery, useOverviewQuery, useOverlayQuery } from './dashboard-queries'

export interface DashboardRuntime {
  ctx: DashboardContext
  bindTicker: (push: (message: ComponentChildren) => void) => void
  navStartedAtMs: number | null
}

function useDashboardPolling(fn: () => void | Promise<unknown>, ms: number, enabled: boolean, timers: DashboardTimers, opts?: { immediate?: boolean }) {
  const saved = useRef(fn)
  const immediate = opts?.immediate ?? true

  useEffect(() => {
    saved.current = fn
  }, [fn])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null

    const schedule = () => {
      timer = timers.setTimeout(() => {
        void tick()
      }, ms)
    }

    const tick = async () => {
      try {
        await saved.current()
      } finally {
        if (!cancelled) schedule()
      }
    }

    if (immediate) {
      void tick()
    } else {
      schedule()
    }

    return () => {
      cancelled = true
      if (timer !== null) timers.clearTimeout(timer)
    }
  }, [enabled, immediate, ms, timers])
}

export function useDashboardRuntime(config: DashboardConfig, deps: DashboardRuntimeDeps = defaultDashboardRuntimeDeps): DashboardRuntime {
  const route = useHashRoute(config.tabs)
  const { navigate, now, rpc, timers } = deps
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
  const [navStartedAtMs, setNavStartedAtMs] = useState<number | null>(null)
  const [overlaySelectionId, setOverlaySelectionId] = useState<string | undefined>(undefined)
  const emitRef = useRef(emit)
  const overlaySelectionIdRef = useRef<string | undefined>(overlaySelectionId)
  const overlayRefetchRef = useRef<() => Promise<unknown> | undefined>(() => undefined)
  const overviewEnabled = route.tab === 'overview'
  const shouldFetchOverviewObservability = overviewEnabled && config.includeOverviewObservability !== false
  const overviewQuery = useOverviewQuery(
    {
      limit: 10,
      root: overviewRootOnly || undefined,
      observabilityWindow: shouldFetchOverviewObservability ? '24h' : undefined,
    },
    overviewEnabled,
    overviewEnabled ? 300_000 : undefined,
  )
  const healthQuery = useHealthQuery(!overviewEnabled && (route.tab === 'processes' || navStartedAtMs === null))
  const overlayDerivedSelectedId = overlay.stepDetail.run?.id ?? overlay.chain[overlay.selectedStepIdx]?.id ?? undefined
  const overlayCorrelationId = overlay.run?.correlationId ?? overlay.stepDetail.run?.correlationId ?? null
  const overlayQuery = useOverlayQuery(
    overlay.open && overlay.runId ? overlay.runId : undefined,
    overlay.open ? overlaySelectionId : undefined,
    overlay.open ? overlayDerivedSelectedId : undefined,
    overlay.open ? overlayCorrelationId : null,
  )

  const overlayRef = useRef(overlay)
  const tickerPushRef = useRef<(message: ComponentChildren) => void>(() => {})

  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])

  useEffect(() => {
    emitRef.current = emit
  }, [emit])

  useEffect(() => {
    overlaySelectionIdRef.current = overlaySelectionId
  }, [overlaySelectionId])

  useEffect(() => {
    overlayRefetchRef.current = () => overlayQuery.refetch()
  }, [overlayQuery])

  const setOverlayState = useCallback((updater: (prev: OverlayState) => OverlayState) => {
    setOverlay((prev) => {
      const next = updater(prev)
      overlayRef.current = next
      return next
    })
  }, [])

  const addTicker = useCallback((node: ComponentChildren) => {
    tickerPushRef.current(<TickerMsg time={timeStr()}>{node}</TickerMsg>)
  }, [])

  const bindTicker = useCallback((push: (message: ComponentChildren) => void) => {
    tickerPushRef.current = push
  }, [])

  const currentHealthData = overviewEnabled ? overviewQuery.data?.health : (healthQuery.data ?? overviewQuery.data?.health)
  const health = useMemo(
    () => ({
      queue: currentHealthData?.queue || {},
      processes: currentHealthData?.processes || [],
    }),
    [currentHealthData],
  )
  const recentRuns = useMemo(() => {
    const runs = overviewQuery.data?.recentRuns?.runs || []
    return {
      runs,
      total: overviewQuery.data?.recentRuns?.total ?? runs.length,
    }
  }, [overviewQuery.data])
  const observability = useMemo(
    () => ({
      summary: shouldFetchOverviewObservability ? overviewQuery.data?.observability?.summary || null : null,
    }),
    [overviewQuery.data, shouldFetchOverviewObservability],
  )

  useEffect(() => {
    if (currentHealthData && typeof currentHealthData.uptime === 'number' && Number.isFinite(currentHealthData.uptime)) {
      setNavStartedAtMs(now() - currentHealthData.uptime * 1000)
      return
    }
    if ((overviewEnabled && overviewQuery.error && !overviewQuery.data) || (!overviewEnabled && healthQuery.error && !healthQuery.data && !overviewQuery.data)) {
      setNavStartedAtMs(null)
    }
  }, [currentHealthData, healthQuery.data, healthQuery.error, now, overviewEnabled, overviewQuery.data, overviewQuery.error])

  useDashboardPolling(
    () => {
      const currentOverlay = overlayRef.current
      if (!currentOverlay.runId) return
      return overlayRefetchRef.current()
    },
    15_000,
    overlay.open && overlay.chain.some((step: any) => step.state !== 'completed' && step.state !== 'errored'),
    timers,
    { immediate: false },
  )

  const applyOverlayPayload = useCallback(
    (runId: string, data: any) => {
      setOverlayState((prev) => ({
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
    },
    [setOverlayState],
  )

  useEffect(() => {
    const currentRunId = overlayRef.current.runId
    if (!currentRunId || !overlayQuery.data) return
    applyOverlayPayload(currentRunId, overlayQuery.data)
  }, [applyOverlayPayload, overlayQuery.data])

  useEffect(() => {
    const currentRunId = overlayRef.current.runId
    if (!currentRunId || !overlayQuery.error) return
    setOverlayState((prev) => {
      if (prev.runId !== currentRunId) return prev
      return { ...prev, run: null, chain: [] }
    })
  }, [overlayQuery.error, setOverlayState])

  const refreshOverlay = useCallback(
    async (runId: string, selectedId?: string) => {
      const currentOverlay = overlayRef.current
      if (currentOverlay.runId !== runId) {
        setOverlaySelectionId(selectedId)
        setOverlayState((prev) => ({ ...prev, open: true, runId, run: null, chain: [], selectedStepIdx: -1, stepDetail: { run: null, effects: [] } }))
        return
      }
      if (selectedId !== undefined && selectedId !== overlaySelectionIdRef.current) {
        setOverlaySelectionId(selectedId)
        return
      }
      await overlayRefetchRef.current()
    },
    [setOverlayState],
  )

  const openOverlay = useCallback(
    (runId: string) => {
      setOverlaySelectionId(undefined)
      setOverlayState((prev) => ({ ...prev, open: true, runId, run: null, chain: [], selectedStepIdx: -1, stepDetail: { run: null, effects: [] } }))
    },
    [setOverlayState],
  )

  const closeOverlay = useCallback(() => {
    setOverlaySelectionId(undefined)
    setOverlayState((prev) => ({ ...prev, open: false, runId: null, run: null, chain: [], selectedStepIdx: -1, stepDetail: { run: null, effects: [] } }))
  }, [setOverlayState])

  const selectStep = useCallback(
    (idx: number) => {
      const currentOverlay = overlayRef.current
      setOverlayState((prev) => ({ ...prev, selectedStepIdx: idx, stepDetail: { run: null, effects: [] } }))
      const runId = currentOverlay.runId
      const selectedId = currentOverlay.chain[idx]?.id
      if (!runId || !selectedId) return
      setOverlaySelectionId(selectedId)
      void refreshOverlay(runId, selectedId)
    },
    [refreshOverlay, setOverlayState],
  )

  const retryStep = useCallback(
    async (runId: string) => {
      try {
        const data = await rpc.runs.retry(runId)
        addTicker(
          <>
            retried <span class="t-event">{shortId(runId)}</span> → <Badge state={data.status || data.state} />
          </>,
        )
        await overlayRefetchRef.current()
      } catch (err: any) {
        addTicker(<>retry failed: {err.message || 'unknown error'}</>)
      }
    },
    [addTicker, rpc],
  )

  const requeueStep = useCallback(
    async (runId: string) => {
      try {
        const data = await rpc.runs.requeue(runId)
        addTicker(
          <>
            requeued <span class="t-event">{shortId(runId)}</span> → <Badge state={data.status || data.state} />
          </>,
        )
        await overlayRefetchRef.current()
      } catch (err: any) {
        addTicker(<>requeue failed: {err.message || 'unknown error'}</>)
      }
    },
    [addTicker, rpc],
  )

  const reemitStep = useCallback(
    (eventName: string, payload: unknown) => {
      closeOverlay()
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
    [closeOverlay, navigate],
  )

  const resumeStep = useCallback(
    async (runId: string) => {
      try {
        const data = await rpc.runs.resume(runId)
        addTicker(
          <>
            resumed <span class="t-event">{shortId(runId)}</span> → {data.runs?.length ?? 0} run(s) created
          </>,
        )
        timers.setTimeout(() => {
          void overlayRefetchRef.current()
        }, 500)
      } catch (err: any) {
        addTicker(<>resume failed: {err.message || 'unknown error'}</>)
      }
    },
    [addTicker, rpc, timers],
  )

  const submitEmit = useCallback(async () => {
    const currentEmit = emitRef.current
    const eventName = currentEmit.eventName.trim()
    if (!eventName) {
      setEmit((prev) => ({ ...prev, result: { ok: false, text: 'Event name is required' } }))
      return
    }

    let payload
    try {
      payload = JSON.parse(currentEmit.payload.trim())
    } catch {
      setEmit((prev) => ({ ...prev, result: { ok: false, text: 'Invalid JSON payload' } }))
      return
    }

    const body: { event: string; payload: unknown; idempotencyKey?: string } = { event: eventName, payload }
    if (currentEmit.idempotencyKey.trim()) body.idempotencyKey = currentEmit.idempotencyKey.trim()

    setEmit((prev) => ({ ...prev, submitting: true }))
    try {
      const data = await rpc.emit.post(body)
      setEmit((prev) => ({ ...prev, submitting: false, result: { ok: true, text: formatJson(data) } }))
      addTicker(
        <>
          emit <span class="t-event">{eventName}</span> → {data.created} run(s) created
        </>,
      )
    } catch (err: any) {
      setEmit((prev) => ({ ...prev, submitting: false, result: { ok: false, text: err.message || 'Request failed' } }))
    }
  }, [addTicker, rpc])

  const viewInTrace = useCallback(
    (rootId: string) => {
      closeOverlay()
      navigate(`/trace/${rootId}`)
    },
    [closeOverlay, navigate],
  )

  const viewInGraph = useCallback(
    (rootId: string) => {
      closeOverlay()
      navigate(`/graph/${rootId}`)
    },
    [closeOverlay, navigate],
  )

  const overlayActions = useMemo<OverlayActions>(
    () => ({
      openOverlay,
      closeOverlay,
      refreshOverlay,
      selectStep,
      retryStep,
      requeueStep,
      reemitStep,
      resumeStep,
      viewInTrace,
      viewInGraph,
    }),
    [closeOverlay, openOverlay, refreshOverlay, reemitStep, requeueStep, retryStep, resumeStep, selectStep, viewInGraph, viewInTrace],
  )

  useDashboardLiveSubscription((event) => {
    const tickerNode = tickerNodeForStreamEvent(event.raw)
    if (tickerNode) addTicker(tickerNode)
  })

  const ctx = useMemo<DashboardContext>(
    () => ({
      route,
      navigate,
      health,
      observability,
      recentRuns,
      overlay,
      overlayActions,
      emit,
      setEmit,
      submitEmit,
      addTicker,
      overviewRootOnly,
      setOverviewRootOnly,
    }),
    [addTicker, emit, health, observability, overlay, overlayActions, overviewRootOnly, recentRuns, route, submitEmit],
  )

  return {
    ctx,
    bindTicker,
    navStartedAtMs,
  }
}
