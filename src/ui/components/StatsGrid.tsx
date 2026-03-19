export function StatsGrid({ queue, extra }: { queue: Record<string, number>; extra?: Array<{ label: string; value: number | string }> }) {
  const stats: [string, number][] = [
    ['Running', queue.running],
    ['Idle', queue.idle],
    ['Completed', queue.completed],
    ['Errored', queue.errored],
  ]
  const hasExtra = extra && extra.length > 0
  return (
    <div class={`grid grid-${hasExtra ? 4 + extra.length : 4} mb-5`}>
      {stats.map(([label, val]) => (
        <div class="card card-flat" key={label}>
          <div class="card-body">
            <span class="label-muted">{label}</span>
            <div class="stat-value">{val ?? 0}</div>
          </div>
        </div>
      ))}
      {extra?.map((item) => (
        <div class="card card-flat" key={item.label}>
          <div class="card-body">
            <span class="label-muted">{item.label}</span>
            <div class="stat-value">{item.value}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
