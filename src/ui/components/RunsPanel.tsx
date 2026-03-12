import { useState, useCallback, useRef } from 'preact/hooks'
import { FilterTabs } from './FilterTabs'
import { RunsTable } from './RunsTable'
import { Pagination } from './Pagination'
import { usePolling } from '../hooks/usePolling'
import { useEventStream } from '../hooks/useEventStream'
import { rpc } from '../lib/rpc'
import type { EngineStreamEvent } from '../../types.js'

export function RunsPanel({ onRowClick, activeRunId }: { onRowClick: (id: string) => void; activeRunId: string | null }) {
  const [filter, setFilter] = useState('all')
  const [rootOnly, setRootOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ runs: any[]; total: number }>({ runs: [], total: 0 })
  const PAGE_SIZE = 50
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchInFlightRef = useRef(false)
  const lastRefreshAtRef = useRef(0)

  const doFetch = useCallback(async () => {
    if (fetchInFlightRef.current) return
    fetchInFlightRef.current = true
    try {
      const result = await rpc.runs.list({
        limit: PAGE_SIZE,
        offset,
        status: filter !== 'all' ? filter : undefined,
        root: rootOnly || undefined,
      })
      setData({ runs: result.runs || [], total: result.total || 0 })
    } catch {}
    finally {
      fetchInFlightRef.current = false
      lastRefreshAtRef.current = Date.now()
    }
  }, [filter, offset, rootOnly])

  const scheduleRefresh = useCallback((delayMs = 200) => {
    if (refreshTimerRef.current) return
    const minIntervalMs = 5_000
    const sinceLast = Date.now() - lastRefreshAtRef.current
    const effectiveDelay = Math.max(delayMs, sinceLast >= minIntervalMs ? 0 : minIntervalMs - sinceLast)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void doFetch()
    }, effectiveDelay)
  }, [doFetch])

  usePolling(doFetch, 30_000, true)
  useEventStream<EngineStreamEvent>(
    '/events',
    (event) => {
      if (event.kind !== 'event') return
      if (event.topics.includes('runs')) {
        scheduleRefresh()
      }
    },
    true,
  )

  const onFilterChange = (f: string) => {
    setFilter(f)
    setOffset(0)
  }

  return (
    <div>
      <div style="display:flex;align-items:center;gap:var(--space-4)">
        <FilterTabs active={filter} onChange={onFilterChange} />
        <label style="display:flex;align-items:center;gap:var(--space-2);cursor:pointer;white-space:nowrap;font-size:var(--text-sm)">
          <input
            type="checkbox"
            checked={rootOnly}
            onChange={(e) => {
              setRootOnly((e.target as HTMLInputElement).checked)
              setOffset(0)
            }}
          />
          Root only
        </label>
      </div>
      {data.runs.length === 0 ? (
        <div class="empty">No runs found</div>
      ) : (
        <RunsTable runs={data.runs} onRowClick={onRowClick} activeRunId={activeRunId} />
      )}
      <Pagination offset={offset} pageSize={PAGE_SIZE} total={data.total} onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))} onNext={() => setOffset(offset + PAGE_SIZE)} />
    </div>
  )
}
