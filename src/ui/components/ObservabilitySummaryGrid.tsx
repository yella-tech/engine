import { formatDurationMs, formatPercent } from '../lib/format'
import type { EngineObservabilitySummary } from '../../types.js'

export function ObservabilitySummaryGrid({ summary }: { summary: EngineObservabilitySummary | null }) {
  const stats: Array<{ label: string; value: string | number; note: string }> = [
    {
      label: 'Run Success',
      value: formatPercent(summary?.runs.successRate),
      note: 'Last 24h',
    },
    {
      label: 'Retries',
      value: summary?.runs.retried ?? 0,
      note: 'Last 24h',
    },
    {
      label: 'Dead Letters',
      value: summary?.runs.deadLetters ?? 0,
      note: 'Last 24h',
    },
    {
      label: 'P95 Run',
      value: formatDurationMs(summary?.runs.duration.p95Ms),
      note: 'Last 24h',
    },
  ]

  return (
    <div class="grid grid-4 mb-5">
      {stats.map(({ label, value, note }) => (
        <div class="card card-flat" key={label}>
          <div class="card-body">
            <span class="label-muted">{label}</span>
            <div class="stat-value">{value}</div>
            <div class="stat-note">{note}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
