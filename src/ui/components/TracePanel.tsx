import { useState, useCallback, useEffect } from 'preact/hooks'
import { TracePicker } from './TracePicker'
import { GanttChart } from './GanttChart'
import { usePolling } from '../hooks/usePolling'
import { navigate } from '../hooks/useHashRoute'
import { rpc } from '../lib/rpc'

export function TracePanel({ chainId, onSpanClick }: { chainId?: string; onSpanClick: (id: string) => void }) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [traceData, setTraceData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const activeId = chainId || selectedId

  const loadTrace = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const data = await rpc.runs.trace(id)
      setTraceData(data)
    } catch {
      setTraceData(null)
    }
    setLoading(false)
  }, [])

  const fetchData = useCallback(async () => {
    try {
      const fetches: Promise<any>[] = [rpc.runs.list({ limit: 100, root: true })]
      if (activeId) fetches.push(rpc.runs.trace(activeId))
      const [runsRes, traceRes] = await Promise.all(fetches)
      const runs = runsRes.runs || []
      setOptions(
        runs.map((r: any) => {
          const when = new Date(r.startedAt).toLocaleTimeString()
          const hasChain = r.childRunIds && r.childRunIds.length > 0
          return { id: r.id, label: `${r.processName} / ${r.eventName}${hasChain ? ' \u25B8 chain' : ''} \u2014 ${when}` }
        }),
      )
      if (activeId && traceRes) {
        setTraceData(traceRes)
      }
    } catch {}
    setLoading(false)
  }, [activeId])

  usePolling(fetchData, 3000, true)

  useEffect(() => {
    setSelectedId(chainId || '')
    if (!chainId) {
      setTraceData(null)
      setLoading(false)
      return
    }
    void loadTrace(chainId)
  }, [chainId, loadTrace])

  const onSelect = useCallback((id: string) => {
    setSelectedId(id)
    if (!id) {
      setTraceData(null)
      navigate('/trace')
      return
    }
    navigate(`/trace/${id}`)
    void loadTrace(id)
  }, [loadTrace])

  return (
    <div>
      <TracePicker options={options} selectedId={activeId} onChange={onSelect} />
      {loading && <div class="empty">Loading trace...</div>}
      {!loading && traceData && <GanttChart trace={traceData} onSpanClick={onSpanClick} />}
      {!loading && activeId && traceData && (!traceData.spans || !traceData.spans.length) && <div class="empty">No trace data</div>}
    </div>
  )
}
