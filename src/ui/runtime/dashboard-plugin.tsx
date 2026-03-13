import type { ComponentChildren } from 'preact'
import type { TabDef } from '../components/Nav'
import type { DashboardConfig, DashboardContext } from './dashboard-types'

export type DashboardPanelRenderer = (ctx: DashboardContext) => ComponentChildren

export interface DashboardPlugin {
  id: string
  tabs: TabDef[]
  panels: Record<string, DashboardPanelRenderer>
}

function collectPluginTabs(plugins: DashboardPlugin[]): TabDef[] {
  const tabs: TabDef[] = []
  const seenIds = new Set<string>()

  for (const plugin of plugins) {
    for (const tab of plugin.tabs) {
      if (seenIds.has(tab.id)) {
        throw new Error(`Duplicate dashboard tab id "${tab.id}" from plugin "${plugin.id}"`)
      }
      seenIds.add(tab.id)
      tabs.push(tab)
    }
  }

  return tabs
}

function collectPluginPanels(plugins: DashboardPlugin[]): Map<string, DashboardPanelRenderer> {
  const panels = new Map<string, DashboardPanelRenderer>()

  for (const plugin of plugins) {
    for (const [tabId, renderPanel] of Object.entries(plugin.panels)) {
      if (panels.has(tabId)) {
        throw new Error(`Duplicate dashboard panel registration for "${tabId}" from plugin "${plugin.id}"`)
      }
      panels.set(tabId, renderPanel)
    }
  }

  return panels
}

export function createDashboardConfigFromPlugins(options: {
  brand: string
  plugins: DashboardPlugin[]
  includeOverviewObservability?: boolean
  onInit?: DashboardConfig['onInit']
}): DashboardConfig {
  const tabs = collectPluginTabs(options.plugins)
  const panels = collectPluginPanels(options.plugins)

  return {
    brand: options.brand,
    tabs,
    onInit: options.onInit,
    includeOverviewObservability: options.includeOverviewObservability,
    renderPanel: (tab, ctx) => panels.get(tab)?.(ctx) ?? null,
  }
}
