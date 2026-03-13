import { NavView } from './Nav'
import { Ticker } from './Ticker'
import { RunOverlay } from './RunOverlay'
import { useDashboardRuntime } from '../runtime/useDashboardRuntime'
import { defaultDashboardRuntimeDeps, type DashboardRuntimeDeps } from '../runtime/dashboard-deps'
import { DashboardLiveProvider } from '../runtime/dashboard-live'
import type { DashboardConfig } from '../runtime/dashboard-types'
import { DashboardQueryProvider } from '../runtime/query-runtime'

export type { DashboardConfig, DashboardContext } from '../runtime/dashboard-types'

function DashboardShellBody({ config, runtimeDeps }: { config: DashboardConfig; runtimeDeps: DashboardRuntimeDeps }) {
  const { ctx, bindTicker, navStartedAtMs } = useDashboardRuntime(config, runtimeDeps)

  return (
    <>
      <NavView brand={config.brand} tabs={config.tabs} activeTab={ctx.route.tab} uptimeStartedAtMs={navStartedAtMs} />

      <div class="dashboard-main">{config.renderPanel(ctx.route.tab, ctx)}</div>

      <Ticker bindPush={bindTicker} />
      <RunOverlay overlay={ctx.overlay} actions={ctx.overlayActions} />
    </>
  )
}

export function DashboardShell({ config, runtimeDeps }: { config: DashboardConfig; runtimeDeps?: DashboardRuntimeDeps }) {
  const resolvedRuntimeDeps = runtimeDeps ?? defaultDashboardRuntimeDeps

  return (
    <DashboardLiveProvider source={resolvedRuntimeDeps.live}>
      <DashboardQueryProvider deps={resolvedRuntimeDeps}>
        <DashboardShellBody config={config} runtimeDeps={resolvedRuntimeDeps} />
      </DashboardQueryProvider>
    </DashboardLiveProvider>
  )
}
