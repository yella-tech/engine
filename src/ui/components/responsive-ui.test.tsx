// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
import { NavView, icons } from './Nav'
import { RunOverlay, type OverlayActions, type OverlayState } from './RunOverlay'
import { RunsTable } from './RunsTable'

const NAV_TABS = [
  { id: 'overview', label: 'Overview', icon: icons.overview, path: '/' },
  { id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' },
]

function makeRun(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    processName: `process-${id}`,
    eventName: `event-${id}`,
    correlationId: `corr-${id}`,
    state: 'completed',
    status: 'completed',
    payload: { ok: true },
    result: { ok: true },
    context: {},
    parentRunId: null,
    startedAt: Date.now(),
    ...overrides,
  }
}

function makeOverlayActions(): OverlayActions {
  return {
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    refreshOverlay: vi.fn(),
    selectStep: vi.fn(),
    retryStep: vi.fn(),
    requeueStep: vi.fn(),
    reemitStep: vi.fn(),
  }
}

describe('responsive dashboard UI', () => {
  it('toggles the mobile nav menu and closes it when a tab is selected', () => {
    const { container } = render(<NavView brand="TEST" tabs={NAV_TABS} activeTab="overview" uptimeStartedAtMs={Date.now() - 1_000} />)

    const nav = container.querySelector('.dashboard-nav')
    expect(nav?.className).not.toContain('menu-open')
    expect(screen.getByRole('link', { name: 'TEST' }).getAttribute('href')).toBe('#/')

    fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }))
    expect(nav?.className).toContain('menu-open')

    fireEvent.click(screen.getByRole('link', { name: /runs/i }))
    expect(nav?.className).not.toContain('menu-open')
  })

  it('keeps the responsive run cards interactive', () => {
    const onRowClick = vi.fn()
    const run = makeRun('run-1', { processName: 'Ingest Email', eventName: 'email:received' })
    const { container } = render(<RunsTable runs={[run]} onRowClick={onRowClick} activeRunId={null} />)

    const card = container.querySelector('.interactive-card')
    expect(card).not.toBeNull()
    expect(container.querySelector('.responsive-card-list')).not.toBeNull()

    fireEvent.click(card!)
    expect(onRowClick).toHaveBeenCalledWith('run-1')
    expect(screen.getByText('Correlation')).toBeTruthy()
  })

  it('renders the run overlay as a dialog and allows backdrop dismissal', () => {
    const run = makeRun('run-1', { processName: 'Process A', eventName: 'event:a' })
    const overlay: OverlayState = {
      open: true,
      runId: run.id,
      run,
      chain: [run],
      selectedStepIdx: 0,
      stepDetail: {
        run,
        effects: [],
      },
    }
    const actions = makeOverlayActions()
    const view = render(<RunOverlay overlay={overlay} actions={actions} />)

    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /close run details/i }))
    expect(actions.closeOverlay).toHaveBeenCalledTimes(1)

    view.rerender(<RunOverlay overlay={{ ...overlay, open: false }} actions={actions} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
