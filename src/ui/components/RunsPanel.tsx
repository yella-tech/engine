import { useState, useCallback } from 'preact/hooks'
import { FilterTabs } from './FilterTabs'
import { RunsTable } from './RunsTable'
import { Pagination } from './Pagination'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/api'

export function RunsPanel({ onRowClick, activeRunId }: { onRowClick: (id: string) => void; activeRunId: string | null }) {
  const [filter, setFilter] = useState('all')
  const [rootOnly, setRootOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ runs: any[]; total: number }>({ runs: [], total: 0 })
  const PAGE_SIZE = 50

  const doFetch = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (filter !== 'all') params.set('status', filter)
      if (rootOnly) params.set('root', 'true')
      const result = await api('/runs?' + params)
      setData({ runs: result.runs || [], total: result.total || 0 })
    } catch {}
  }, [filter, offset, rootOnly])

  usePolling(doFetch, 3000, true)

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
