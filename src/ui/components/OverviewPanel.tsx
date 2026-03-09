import type { ComponentChildren } from 'preact'
import { StatsGrid } from './StatsGrid'
import { RunsTable } from './RunsTable'

export function OverviewPanel({
  health,
  recentRuns,
  onRowClick,
  activeRunId,
  extraStats,
  rootOnly,
  onRootOnlyChange,
}: {
  health: { queue: Record<string, number> }
  recentRuns: { runs: any[]; total: number }
  onRowClick: (id: string) => void
  activeRunId: string | null
  extraStats?: ComponentChildren
  rootOnly?: boolean
  onRootOnlyChange?: (v: boolean) => void
}) {
  return (
    <div>
      <StatsGrid queue={health.queue || {}} />
      {extraStats}
      <div class="label mb-3" style="display:flex;align-items:center;gap:var(--space-4)">
        <span>
          Recent Runs <span class="badge badge-idle">{recentRuns.total ?? 0}</span>
        </span>
        {onRootOnlyChange && (
          <label style="display:flex;align-items:center;gap:var(--space-2);font-weight:400">
            <input type="checkbox" checked={rootOnly} onChange={(e) => onRootOnlyChange((e.target as HTMLInputElement).checked)} />
            <span class="label-muted" style="margin:0">Root only</span>
          </label>
        )}
      </div>
      <RunsTable runs={recentRuns.runs} onRowClick={onRowClick} activeRunId={activeRunId} />
    </div>
  )
}
