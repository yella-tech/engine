import { ObservabilitySummaryGrid } from '../components/ObservabilitySummaryGrid'
import { OverviewPanel } from '../components/OverviewPanel'
import { ProcessesPanel } from '../components/ProcessesPanel'
import { RunsPanel } from '../components/RunsPanel'
import { TracePanel } from '../components/TracePanel'
import { GraphPanel } from '../components/GraphPanel'
import { EmitPanel } from '../components/EmitPanel'
import { icons } from '../components/Nav'
import type { DashboardPanelRenderer, DashboardPlugin } from '../runtime/dashboard-plugin'

export interface EngineDashboardPluginOptions {
  renderOverviewStats?: DashboardPanelRenderer
}

export function createEngineDashboardPlugin(options: EngineDashboardPluginOptions = {}): DashboardPlugin {
  const renderOverviewStats = options.renderOverviewStats ?? ((ctx) => <ObservabilitySummaryGrid summary={ctx.observability.summary} />)

  return {
    id: 'engine-core',
    tabs: [
      { id: 'overview', label: 'Overview', icon: icons.overview, path: '/' },
      { id: 'processes', label: 'Processes', icon: icons.processes, path: '/processes' },
      { id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' },
      { id: 'trace', label: 'Trace', icon: icons.trace, path: '/trace' },
      { id: 'trace-detail', label: 'Trace', icon: icons.trace, path: '/trace/:chainId', hidden: true },
      { id: 'graph', label: 'Graph', icon: icons.graph, path: '/graph' },
      { id: 'graph-detail', label: 'Graph', icon: icons.graph, path: '/graph/:chainId', hidden: true },
      { id: 'emit', label: 'Emit', icon: icons.emit, path: '/emit' },
    ],
    panels: {
      overview: (ctx) => (
        <OverviewPanel
          health={ctx.health}
          recentRuns={ctx.recentRuns}
          onRowClick={ctx.overlayActions.openOverlay}
          activeRunId={ctx.overlay.open ? ctx.overlay.runId : null}
          extraStats={renderOverviewStats(ctx)}
          rootOnly={ctx.overviewRootOnly}
          onRootOnlyChange={ctx.setOverviewRootOnly}
        />
      ),
      processes: (ctx) => (
        <ProcessesPanel
          processes={ctx.health.processes}
          onEmit={(event) => {
            ctx.navigate('/emit')
            ctx.setEmit({ eventName: event, payload: '{}', idempotencyKey: '', result: null, submitting: false, focusPayload: false })
          }}
          onGraph={() => ctx.navigate('/graph')}
        />
      ),
      runs: (ctx) => <RunsPanel onRowClick={ctx.overlayActions.openOverlay} activeRunId={ctx.overlay.open ? ctx.overlay.runId : null} />,
      trace: (ctx) => <TracePanel chainId={ctx.route.params.chainId} onSpanClick={ctx.overlayActions.openOverlay} />,
      'trace-detail': (ctx) => <TracePanel chainId={ctx.route.params.chainId} onSpanClick={ctx.overlayActions.openOverlay} />,
      graph: (ctx) => <GraphPanel chainId={ctx.route.params.chainId} onNodeClick={ctx.overlayActions.openOverlay} />,
      'graph-detail': (ctx) => <GraphPanel chainId={ctx.route.params.chainId} onNodeClick={ctx.overlayActions.openOverlay} />,
      emit: (ctx) => <EmitPanel emit={ctx.emit} onUpdate={(patch) => ctx.setEmit((prev) => ({ ...prev, ...patch }))} onSubmit={() => void ctx.submitEmit()} />,
    },
  }
}
