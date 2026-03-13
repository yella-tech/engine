import type { ComponentChildren } from 'preact'
import type { OverlayActions, OverlayState } from '../components/RunOverlay'
import type { EmitState } from '../components/EmitPanel'
import type { TabDef } from '../components/Nav'
import type { RouteMatch } from '../hooks/useHashRoute'
import type { EngineObservabilitySummary } from '../../types.js'

export interface DashboardConfig {
  brand: string
  tabs: TabDef[]
  renderPanel: (tab: string, ctx: DashboardContext) => ComponentChildren
  onInit?: (ctx: DashboardContext) => void
  includeOverviewObservability?: boolean
}

export interface DashboardContext {
  route: RouteMatch
  navigate: (path: string) => void
  health: { queue: Record<string, number>; processes: any[] }
  observability: { summary: EngineObservabilitySummary | null }
  recentRuns: { runs: any[]; total: number }
  overlay: OverlayState
  overlayActions: OverlayActions
  emit: EmitState
  setEmit: (s: EmitState | ((prev: EmitState) => EmitState)) => void
  submitEmit: () => Promise<void>
  addTicker: (node: ComponentChildren) => void
  overviewRootOnly: boolean
  setOverviewRootOnly: (v: boolean) => void
}
