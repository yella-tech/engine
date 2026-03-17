export function ProcessesPanel({
  processes,
  onEmit,
  onGraph,
}: {
  processes: any[]
  onEmit: (event: string) => void
  onGraph?: (name: string) => void
}) {
  if (!processes || !processes.length) {
    return <div class="empty">No processes registered</div>
  }

  return (
    <>
      <div class="table-wrap responsive-table">
        <table class="table processes-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Event</th>
              <th class="processes-table-actions-head">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {processes.map((p: any) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.event}</td>
                <td class="processes-table-actions">
                  <div class="table-action-group">
                    {onGraph && (
                      <button class="btn btn-sm" onClick={() => onGraph(p.name)}>
                        Graph
                      </button>
                    )}
                    <button class="btn btn-sm" onClick={() => onEmit(p.event)}>
                      Emit
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="responsive-card-list" aria-label="Processes list">
        {processes.map((p: any) => (
          <div class="responsive-card" key={p.name}>
            <div class="responsive-card-head">
              <div>
                <span class="label-muted">Process</span>
                <div class="responsive-card-title">{p.name}</div>
              </div>
            </div>
            <div class="responsive-card-grid">
              <div class="responsive-card-cell">
                <span class="label-muted">Event</span>
                <span class="responsive-card-meta">{p.event}</span>
              </div>
            </div>
            <div class="responsive-card-actions">
              {onGraph && (
                <button class="btn btn-sm" onClick={() => onGraph(p.name)}>
                  Graph
                </button>
              )}
              <button class="btn btn-sm" onClick={() => onEmit(p.event)}>
                Emit
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
