// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { NavView, icons, type TabDef } from './Nav'

const tabs: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: icons.overview, path: '/' },
  { id: 'runs', label: 'Runs', icon: icons.runs, path: '/runs' },
]

afterEach(() => {
  cleanup()
})

describe('NavView', () => {
  it('toggles the mobile navigation menu state', () => {
    render(<NavView brand="TEST" tabs={tabs} activeTab="overview" uptimeStartedAtMs={null} />)

    const toggle = screen.getByRole('button', { name: /open navigation menu/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /close navigation menu/i }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('link', { name: /runs/i })).toBeTruthy()
  })

  it('closes the mobile navigation menu when the active tab changes', async () => {
    const { rerender } = render(<NavView brand="TEST" tabs={tabs} activeTab="overview" uptimeStartedAtMs={null} />)

    fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }))
    expect(screen.getByRole('button', { name: /close navigation menu/i }).getAttribute('aria-expanded')).toBe('true')

    rerender(<NavView brand="TEST" tabs={tabs} activeTab="runs" uptimeStartedAtMs={null} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open navigation menu/i }).getAttribute('aria-expanded')).toBe('false')
    })
  })
})
