import { useState, useCallback, useEffect, useMemo } from 'preact/hooks'
import { TracePicker } from './TracePicker'
import { GanttChart } from './GanttChart'
import { navigate } from '../hooks/useHashRoute'
import { useRootRunsQuery, useTraceQuery } from '../runtime/dashboard-queries'

export function TracePanel({ chainId, onSpanClick }: { chainId?: string; onSpanClick: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState('')
  const activeId = chainId || selectedId
  const optionsQuery = useRootRunsQuery(100)
  const traceQuery = useTraceQuery(activeId)
  const options = useMemo(
    () =>
      (optionsQuery.data?.runs || []).map((r: any) => {
        const when = new Date(r.startedAt).toLocaleTimeString()
        const hasChain = r.childRunIds && r.childRunIds.length > 0
        return { id: r.id, label: `${r.processName} / ${r.eventName}${hasChain ? ' \u25B8 chain' : ''} \u2014 ${when}` }
      }),
    [optionsQuery.data],
  )

  useEffect(() => {
    setSelectedId(chainId || '')
    if (!chainId) {
      return
    }
  }, [chainId])

  const onSelect = useCallback((id: string) => {
    setSelectedId(id)
    if (!id) {
      navigate('/trace')
      return
    }
    navigate(`/trace/${id}`)
  }, [])

  const traceData = traceQuery.data ?? null
  const loading = (optionsQuery.isFetching && !optionsQuery.data) || (traceQuery.isFetching && !traceQuery.data)

  return (
    <div>
      <TracePicker options={options} selectedId={activeId} onChange={onSelect} />
      {loading && <div class="empty">Loading trace...</div>}
      {!loading && traceData && <GanttChart trace={traceData} onSpanClick={onSpanClick} />}
      {!loading && activeId && traceData && (!traceData.spans || !traceData.spans.length) && <div class="empty">No trace data</div>}
    </div>
  )
}
