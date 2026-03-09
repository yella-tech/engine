import { render } from 'preact'
import { DashboardShell, type DashboardConfig, type DashboardContext } from './components/DashboardShell'
import { OverviewPanel } from './components/OverviewPanel'
import { ProcessesPanel } from './components/ProcessesPanel'
import { RunsPanel } from './components/RunsPanel'
import { TracePanel } from './components/TracePanel'
import { GraphPanel } from './components/GraphPanel'
import { EmitPanel } from './components/EmitPanel'
import { icons } from './components/Nav'
import { api } from './lib/api'
import { formatJson } from './lib/format'
import './styles.css'

function App() {
  const config: DashboardConfig = {
    brand: 'YELLA',
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
    renderPanel: (tab, ctx) => {
      switch (tab) {
        case 'overview':
          return <OverviewPanel health={ctx.health} recentRuns={ctx.recentRuns} onRowClick={ctx.overlayActions.openOverlay} activeRunId={ctx.overlay.open ? ctx.overlay.runId : null} />
        case 'processes':
          return (
            <ProcessesPanel
              processes={ctx.health.processes}
              onEmit={(event) => {
                ctx.navigate('/emit')
                ctx.setEmit({ eventName: event, payload: '{}', idempotencyKey: '', result: null, submitting: false, focusPayload: false })
              }}
              onGraph={(name) => {
                ctx.navigate('/graph')
                ctx.setGraphMode({ process: name })
              }}
            />
          )
        case 'runs':
          return <RunsPanel onRowClick={ctx.overlayActions.openOverlay} activeRunId={ctx.overlay.open ? ctx.overlay.runId : null} />
        case 'trace':
        case 'trace-detail':
          return <TracePanel onSpanClick={ctx.overlayActions.openOverlay} />
        case 'graph':
        case 'graph-detail':
          return (
            <GraphPanel
              mode={ctx.graphMode}
              onNodeClick={(name) => {
                ctx.setGraphMode({ process: name })
              }}
            />
          )
        case 'emit':
          return <EmitPanel emit={ctx.emit} onUpdate={(patch) => ctx.setEmit((prev) => ({ ...prev, ...patch }))} onSubmit={() => handleEmit(ctx)} />
        default:
          return null
      }
    },
  }

  return <DashboardShell config={config} />
}

async function handleEmit(ctx: DashboardContext) {
  const { emit } = ctx
  const eventName = emit.eventName.trim()
  if (!eventName) {
    ctx.setEmit((prev) => ({ ...prev, result: { ok: false, text: 'Event name is required' } }))
    return
  }
  let payload
  try {
    payload = JSON.parse(emit.payload.trim())
  } catch {
    ctx.setEmit((prev) => ({ ...prev, result: { ok: false, text: 'Invalid JSON payload' } }))
    return
  }
  const body: any = { event: eventName, payload }
  if (emit.idempotencyKey.trim()) body.idempotencyKey = emit.idempotencyKey.trim()

  ctx.setEmit((prev) => ({ ...prev, submitting: true }))
  try {
    const data = await api('/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    ctx.setEmit((prev) => ({ ...prev, submitting: false, result: { ok: true, text: formatJson(data) } }))
    ctx.addTicker(
      <>
        emit <span class="t-event">{eventName}</span> → {data.created} run(s) created
      </>,
    )
  } catch (err: any) {
    ctx.setEmit((prev) => ({ ...prev, submitting: false, result: { ok: false, text: err.message || 'Request failed' } }))
  }
}

render(<App />, document.getElementById('app')!)
