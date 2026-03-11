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
    <div class="table-wrap">
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
  )
}
