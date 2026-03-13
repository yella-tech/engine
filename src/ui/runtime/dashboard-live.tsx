import { createContext, type ComponentChildren } from 'preact'
import { useContext, useEffect, useMemo, useRef } from 'preact/hooks'
import type { EngineStreamEvent } from '../../types.js'
import { Badge } from '../components/Badge'
import type { DashboardLiveSource } from './dashboard-deps'

export interface DashboardLiveEvent {
  raw: EngineStreamEvent
  tags: string[]
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

export function tickerNodeForStreamEvent(event: EngineStreamEvent): ComponentChildren | null {
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

export function streamEventTags(event: EngineStreamEvent): string[] {
  if (event.kind !== 'event') return []

  const tags = new Set<string>()
  for (const topic of event.topics) {
    tags.add(topic)
    if (topic === 'trace') {
      tags.add('chain')
    }
    if (topic === 'overlay') {
      if (event.runId) {
        tags.add(`overlay:run:${event.runId}`)
      }
      if (event.correlationId) {
        tags.add(`overlay:correlation:${event.correlationId}`)
      }
    }
  }

  return [...tags]
}

type DashboardLiveListener = (event: DashboardLiveEvent) => void

export class DashboardLiveRuntime {
  private readonly listeners = new Set<DashboardLiveListener>()
  private unsubscribeSource: (() => void) | null = null

  constructor(private readonly source: DashboardLiveSource<EngineStreamEvent>) {}

  dispose() {
    if (this.unsubscribeSource) {
      this.unsubscribeSource()
      this.unsubscribeSource = null
    }
    this.listeners.clear()
  }

  subscribe(listener: DashboardLiveListener): () => void {
    this.listeners.add(listener)
    this.ensureConnected()

    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.unsubscribeSource) {
        this.unsubscribeSource()
        this.unsubscribeSource = null
      }
    }
  }

  private ensureConnected() {
    if (this.unsubscribeSource || this.listeners.size === 0) return

    this.unsubscribeSource = this.source.subscribe((raw) => {
      const normalized = {
        raw,
        tags: streamEventTags(raw),
      }

      for (const listener of this.listeners) {
        listener(normalized)
      }
    })
  }
}

const DashboardLiveContext = createContext<DashboardLiveRuntime | null>(null)

export function DashboardLiveProvider({ source, children }: { source: DashboardLiveSource<EngineStreamEvent>; children: ComponentChildren }) {
  const runtime = useMemo(() => new DashboardLiveRuntime(source), [source])

  useEffect(() => {
    return () => {
      runtime.dispose()
    }
  }, [runtime])

  return <DashboardLiveContext.Provider value={runtime}>{children}</DashboardLiveContext.Provider>
}

export function useDashboardLiveRuntime() {
  const runtime = useContext(DashboardLiveContext)
  if (!runtime) {
    throw new Error('DashboardLiveProvider is required')
  }
  return runtime
}

export function useDashboardLiveSubscription(listener: DashboardLiveListener, enabled = true) {
  const runtime = useDashboardLiveRuntime()
  const saved = useRef(listener)

  useEffect(() => {
    saved.current = listener
  }, [listener])

  useEffect(() => {
    if (!enabled) return
    return runtime.subscribe((event) => {
      saved.current(event)
    })
  }, [enabled, runtime])
}
