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
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [loadingTrace, setLoadingTrace] = useState(false)
  const activeId = chainId || selectedId

  const loadOptions = useCallback(async () => {
    try {
      setLoadingOptions(true)
      const runsRes = await rpc.runs.list({ limit: 100, root: true })
      const runs = runsRes.runs || []
      setOptions(
        runs.map((r: any) => {
          const when = new Date(r.startedAt).toLocaleTimeString()
          const hasChain = r.childRunIds && r.childRunIds.length > 0
          return { id: r.id, label: `${r.processName} / ${r.eventName}${hasChain ? ' \u25B8 chain' : ''} \u2014 ${when}` }
        }),
      )
    } catch {
      setOptions([])
    } finally {
      setLoadingOptions(false)
    }
  }, [])

  const loadTrace = useCallback(async (id: string) => {
    try {
      setLoadingTrace(true)
      const data = await rpc.runs.trace(id)
      setTraceData(data)
    } catch {}
    finally {
      setLoadingTrace(false)
    }
  }, [])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  useEffect(() => {
    setSelectedId(chainId || '')
    if (!chainId) {
      setTraceData(null)
      setLoadingTrace(false)
      return
    }
    void loadTrace(chainId)
  }, [chainId, loadTrace])

  usePolling(() => {
    if (activeId) {
      void loadTrace(activeId)
    }
  }, 10_000, !!activeId, { immediate: false })

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

  const loading = loadingOptions || loadingTrace

  return (
    <div>
      <TracePicker options={options} selectedId={activeId} onChange={onSelect} />
      {loading && <div class="empty">Loading trace...</div>}
      {!loading && traceData && <GanttChart trace={traceData} onSpanClick={onSpanClick} />}
      {!loading && activeId && traceData && (!traceData.spans || !traceData.spans.length) && <div class="empty">No trace data</div>}
    </div>
  )
}
