import { useState, useCallback, useEffect } from 'preact/hooks'
import { TracePicker } from './TracePicker'
import { GanttChart } from './GanttChart'
import { api } from '../lib/api'

export function TracePanel({ chainId, onSpanClick }: { chainId?: string; onSpanClick: (id: string) => void }) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [traceData, setTraceData] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  const loadOptions = useCallback(async () => {
    try {
      const data = await api('/runs?limit=100&root=true')
      const runs = data.runs || []

      setOptions(
        runs.map((r: any) => {
          const when = new Date(r.startedAt).toLocaleTimeString()
          const hasChain = r.childRunIds && r.childRunIds.length > 0
          return { id: r.id, label: `${r.processName} / ${r.eventName}${hasChain ? ' \u25B8 chain' : ''} \u2014 ${when}` }
        }),
      )
    } catch {}
  }, [])

  useEffect(() => {
    loadOptions()
  }, [])

  const onSelect = useCallback(async (id: string) => {
    setSelectedId(id)
    if (!id) {
      setTraceData(null)
      return
    }
    setLoading(true)
    try {
      const data = await api('/runs/' + id + '/trace')
      setTraceData(data)
    } catch {
      setTraceData(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (chainId) {
      onSelect(chainId)
    }
  }, [chainId])

  return (
    <div>
      <TracePicker options={options} selectedId={selectedId} onChange={onSelect} />
      {loading && <div class="empty">Loading trace...</div>}
      {!loading && traceData && <GanttChart trace={traceData} onSpanClick={onSpanClick} />}
      {!loading && selectedId && traceData && (!traceData.spans || !traceData.spans.length) && <div class="empty">No trace data</div>}
    </div>
  )
}
