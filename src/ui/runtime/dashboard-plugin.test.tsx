import { describe, expect, it } from 'vitest'
import { icons } from '../components/Nav'
import { createEngineDashboardPlugin } from '../plugins/engine-plugin'
import type { DashboardContext } from './dashboard-types'
import { createDashboardConfigFromPlugins } from './dashboard-plugin'

function makeContext(): DashboardContext {
  return {
    route: { tab: 'overview', path: '/', params: {} },
    navigate: () => {},
    health: { queue: {}, processes: [] },
    observability: { summary: null },
    recentRuns: { runs: [], total: 0 },
    overlay: {
      open: false,
      runId: null,
      run: null,
      chain: [],
      selectedStepIdx: -1,
      stepDetail: { run: null, effects: [] },
    },
    overlayActions: {
      openOverlay: () => {},
      closeOverlay: () => {},
      refreshOverlay: async () => {},
      selectStep: () => {},
      retryStep: async () => {},
      requeueStep: async () => {},
      reemitStep: () => {},
      resumeStep: async () => {},
      viewInTrace: () => {},
      viewInGraph: () => {},
    },
    emit: {
      eventName: '',
      payload: '{}',
      idempotencyKey: '',
      result: null,
      submitting: false,
      focusPayload: false,
    },
    setEmit: () => {},
    submitEmit: async () => {},
    addTicker: () => {},
    overviewRootOnly: false,
    setOverviewRootOnly: () => {},
  }
}

describe('createDashboardConfigFromPlugins', () => {
  it('composes plugin tabs and panel renderers into the existing DashboardConfig shape', () => {
    const config = createDashboardConfigFromPlugins({
      brand: 'TEST',
      plugins: [
        {
          id: 'engine-core',
          tabs: [{ id: 'overview', label: 'Overview', icon: icons.overview, path: '/' }],
          panels: {
            overview: () => <div>Overview Panel</div>,
          },
        },
      ],
    })

    expect(config.brand).toBe('TEST')
    expect(config.tabs).toHaveLength(1)
    expect(config.tabs[0]?.id).toBe('overview')
    expect(config.renderPanel('overview', makeContext())).toBeTruthy()
    expect(config.renderPanel('missing', makeContext())).toBeNull()
  })

  it('rejects duplicate tab ids across plugins', () => {
    expect(() =>
      createDashboardConfigFromPlugins({
        brand: 'TEST',
        plugins: [
          {
            id: 'first',
            tabs: [{ id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' }],
            panels: { runs: () => null },
          },
          {
            id: 'second',
            tabs: [{ id: 'runs', label: 'Runs Again', icon: icons.runs, path: '/runs-2' }],
            panels: { other: () => null },
          },
        ],
      }),
    ).toThrow('Duplicate dashboard tab id "runs"')
  })

  it('rejects duplicate panel registrations across plugins', () => {
    expect(() =>
      createDashboardConfigFromPlugins({
        brand: 'TEST',
        plugins: [
          {
            id: 'first',
            tabs: [{ id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' }],
            panels: { runs: () => null },
          },
          {
            id: 'second',
            tabs: [{ id: 'trace', label: 'Trace', icon: icons.trace, path: '/trace' }],
            panels: { runs: () => null },
          },
        ],
      }),
    ).toThrow('Duplicate dashboard panel registration for "runs"')
  })

  it('allows the engine core plugin overview stats to be replaced without re-registering panels', () => {
    const plugin = createEngineDashboardPlugin({
      renderOverviewStats: () => <div>Custom Overview Stats</div>,
    })

    const overview = plugin.panels.overview?.(makeContext()) as any
    expect(overview?.props.extraStats?.props.children).toBe('Custom Overview Stats')
  })
})
