import { useState, useEffect } from 'preact/hooks'
import type { TabDef } from '../components/Nav'

export interface RouteMatch {
  tab: string
  params: Record<string, string>
  path: string
}

function matchPath(pattern: string, path: string): { params: Record<string, string> } | null {
  const patternParts = pattern.split('/')
  const pathParts = path.split('/')
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i]
    } else if (patternParts[i] !== pathParts[i]) {
      return null
    }
  }
  return { params }
}

export function useHashRoute(tabs: TabDef[]): RouteMatch {
  const [hash, setHash] = useState(location.hash.slice(1) || '/')
  useEffect(() => {
    const onHash = () => setHash(location.hash.slice(1) || '/')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  for (const tab of tabs) {
    if (!tab.path) continue
    const match = matchPath(tab.path, hash)
    if (match) return { tab: tab.id, params: match.params, path: hash }
  }
  return { tab: tabs[0]?.id || '', params: {}, path: hash }
}

export function navigate(path: string) {
  location.hash = '#' + path
}
