export function StatsGrid({ queue }: { queue: Record<string, number> }) {
  const stats: [string, number][] = [
    ['Running', queue.running],
    ['Idle', queue.idle],
    ['Completed', queue.completed],
    ['Errored', queue.errored],
  ]
  return (
    <div class="grid grid-4 mb-5">
      {stats.map(([label, val]) => (
        <div class="card card-flat" key={label}>
          <div class="card-body">
            <span class="label-muted">{label}</span>
            <div class="stat-value">{val ?? 0}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
