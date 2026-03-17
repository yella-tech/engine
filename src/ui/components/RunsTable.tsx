import { Badge } from './Badge'
import { shortId, timeAgo, runStatus } from '../lib/format'

export function RunsTable({
  runs,
  onRowClick,
  activeRunId,
}: {
  runs: any[]
  onRowClick: (id: string) => void
  activeRunId: string | null
}) {
  if (!runs || !runs.length) {
    return <div class="empty">No runs yet</div>
  }

  return (
    <>
      <div class="table-wrap responsive-table">
        <table class="table table-hover">
          <thead>
            <tr>
              <th>ID</th>
              <th>Process</th>
              <th>Event</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r: any) => (
              <tr key={r.id} class={`clickable ${r.id === activeRunId ? 'active-row' : ''}`} onClick={() => onRowClick(r.id)}>
                <td>{shortId(r.id)}</td>
                <td>{r.processName || '--'}</td>
                <td>{r.eventName || '--'}</td>
                <td>
                  <Badge state={runStatus(r)} />
                </td>
                <td class="label-muted">{timeAgo(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="responsive-card-list" aria-label="Runs list">
        {runs.map((r: any) => {
          const status = runStatus(r)
          return (
            <button
              type="button"
              key={r.id}
              class={`responsive-card interactive-card ${r.id === activeRunId ? 'active-card' : ''}`}
              aria-pressed={r.id === activeRunId}
              onClick={() => onRowClick(r.id)}
            >
              <div class="responsive-card-head">
                <div>
                  <span class="label-muted">Run</span>
                  <div class="responsive-card-title">{r.processName || '--'}</div>
                </div>
                <Badge state={status} />
              </div>
              <div class="responsive-card-grid">
                <div class="responsive-card-cell">
                  <span class="label-muted">ID</span>
                  <span class="responsive-card-meta">{shortId(r.id)}</span>
                </div>
                <div class="responsive-card-cell">
                  <span class="label-muted">When</span>
                  <span class="responsive-card-meta">{timeAgo(r.startedAt)}</span>
                </div>
                <div class="responsive-card-cell">
                  <span class="label-muted">Event</span>
                  <span class="responsive-card-meta">{r.eventName || '--'}</span>
                </div>
                <div class="responsive-card-cell">
                  <span class="label-muted">Correlation</span>
                  <span class="responsive-card-meta">{shortId(r.correlationId)}</span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}
