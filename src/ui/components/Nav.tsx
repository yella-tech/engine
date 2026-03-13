import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useHashRoute } from '../hooks/useHashRoute'
import { formatUptime } from '../lib/format'

export interface TabDef {
  id: string
  label: string
  icon: ComponentChildren
  path: string
  hidden?: boolean
}

export function NavView({
  brand,
  tabs,
  activeTab,
  uptimeStartedAtMs,
}: {
  brand: string
  tabs: TabDef[]
  activeTab: string
  uptimeStartedAtMs: number | null
}) {
  const visibleTabs = tabs.filter((t) => !t.hidden)
  const [uptime, setUptime] = useState('--')

  useEffect(() => {
    if (uptimeStartedAtMs === null) {
      setUptime('--')
      return
    }

    const update = () => {
      setUptime(formatUptime(Math.max(0, (Date.now() - uptimeStartedAtMs) / 1000)))
    }

    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [uptimeStartedAtMs])

  return (
    <nav class="nav">
      <a class="nav-brand" href="/">
        {brand}
      </a>
      <ul class="nav-items">
        {visibleTabs.map((t) => (
          <li class="nav-item" key={t.id}>
            <a class={`nav-link ${activeTab === t.id ? 'active' : ''}`} href={`#${t.path}`} title={t.id}>
              {t.icon}
              <span class="hide-mobile">{t.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <div style="margin-left:auto;display:flex;align-items:center;gap:var(--space-3);padding-right:var(--space-4)">
        <div class="status-dot"></div>
        <span class="label-muted" style="margin:0">
          {uptime}
        </span>
      </div>
    </nav>
  )
}

export function Nav({
  brand,
  tabs,
  uptimeStartedAtMs,
}: {
  brand: string
  tabs: TabDef[]
  uptimeStartedAtMs: number | null
}) {
  const route = useHashRoute(tabs)
  return <NavView brand={brand} tabs={tabs} activeTab={route.tab} uptimeStartedAtMs={uptimeStartedAtMs} />
}

// Standard icons
export const icons = {
  overview: (
    <svg viewBox="0 0 24 24">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  connectors: (
    <svg viewBox="0 0 24 24">
      <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
    </svg>
  ),
  processes: (
    <svg viewBox="0 0 24 24">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  ),
  runs: (
    <svg viewBox="0 0 24 24">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  trace: (
    <svg viewBox="0 0 24 24">
      <line x1="3" y1="6" x2="15" y2="6" />
      <line x1="5" y1="12" x2="21" y2="12" />
      <line x1="7" y1="18" x2="18" y2="18" />
    </svg>
  ),
  emit: (
    <svg viewBox="0 0 24 24">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22 11 13 2 9l20-7z" />
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <line x1="7.5" y1="11" x2="16.5" y2="7" />
      <line x1="7.5" y1="13" x2="16.5" y2="17" />
    </svg>
  ),
}
