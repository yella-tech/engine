import { useState } from 'preact/hooks'
import { FilterTabs } from './FilterTabs'
import { RunsTable } from './RunsTable'
import { Pagination } from './Pagination'
import { useRunsListQuery } from '../runtime/dashboard-queries'

export function RunsPanel({ onRowClick, activeRunId }: { onRowClick: (id: string) => void; activeRunId: string | null }) {
  const [filter, setFilter] = useState('all')
  const [rootOnly, setRootOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const PAGE_SIZE = 50
  const data = useRunsListQuery({
    limit: PAGE_SIZE,
    offset,
    status: filter !== 'all' ? filter : undefined,
    root: rootOnly || undefined,
    pollMs: 30_000,
  })
  const runs = data.data?.runs || []
  const total = data.data?.total || 0

  const onFilterChange = (f: string) => {
    setFilter(f)
    setOffset(0)
  }

  return (
    <div>
      <div class="panel-toolbar mb-4">
        <FilterTabs active={filter} onChange={onFilterChange} />
        <label class="panel-toggle">
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
      {runs.length === 0 ? (
        <div class="empty">No runs found</div>
      ) : (
        <RunsTable runs={runs} onRowClick={onRowClick} activeRunId={activeRunId} />
      )}
      <Pagination offset={offset} pageSize={PAGE_SIZE} total={total} onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))} onNext={() => setOffset(offset + PAGE_SIZE)} />
    </div>
  )
}
