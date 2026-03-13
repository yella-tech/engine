import './styles.css'

// Layout
export { DashboardShell } from './components/DashboardShell'
export type { DashboardConfig, DashboardContext } from './components/DashboardShell'
export { Nav, icons } from './components/Nav'
export type { TabDef } from './components/Nav'
export { RunOverlay } from './components/RunOverlay'
export type { OverlayState, OverlayActions } from './components/RunOverlay'

// Panels
export { OverviewPanel } from './components/OverviewPanel'
export { ObservabilitySummaryGrid } from './components/ObservabilitySummaryGrid'
export { ProcessesPanel } from './components/ProcessesPanel'
export { RunsPanel } from './components/RunsPanel'
export { TracePanel } from './components/TracePanel'
export { GraphPanel } from './components/GraphPanel'
export { EmitPanel } from './components/EmitPanel'
export type { EmitState } from './components/EmitPanel'

// Shared
export { Badge, DeferredBadge } from './components/Badge'
export { JsonBlock } from './components/JsonBlock'
export { DetailRow } from './components/DetailRow'
export { GanttChart } from './components/GanttChart'
export { Ticker, TickerMsg } from './components/Ticker'
export { StepDetail } from './components/StepDetail'
export { Timeline } from './components/Timeline'

// Hooks
export { useEscapeKey } from './hooks/useEscapeKey'
export { useHashRoute, navigate, buildHashPath } from './hooks/useHashRoute'
export type { RouteMatch } from './hooks/useHashRoute'
export { useDashboardQuery, useDashboardRuntimeDeps } from './runtime/query-runtime'
export type { DashboardQueryKey, DashboardQueryKeyPart, DashboardQueryOptions, DashboardQueryResult, DashboardQuerySnapshot } from './runtime/query-runtime'

// Plugins
export { createDashboardConfigFromPlugins } from './runtime/dashboard-plugin'
export type { DashboardPanelRenderer, DashboardPlugin } from './runtime/dashboard-plugin'
export { createEngineDashboardPlugin } from './plugins/engine-plugin'
export type { EngineDashboardPluginOptions } from './plugins/engine-plugin'

// Utilities
export { api } from './lib/api'
export { rpc } from './lib/rpc'
export { shortId, formatUptime, formatJson, timeAgo, timeStr, formatPercent, formatDurationMs, stripEffectPrefix, runStatus, isDeferred } from './lib/format'
export { compressTimeline } from './lib/compress'
export type { CompressedTimeline } from './lib/compress'
