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
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Event</th>
            <th style="width:1%;white-space:nowrap"></th>
          </tr>
        </thead>
        <tbody>
          {processes.map((p: any) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.event}</td>
              <td style="white-space:nowrap;text-align:right">
                <div style="display:inline-flex;gap:var(--space-2)">
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
  )
}
