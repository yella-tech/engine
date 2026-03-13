import { useState, useEffect } from 'preact/hooks'
import type { TabDef } from '../components/Nav'

export interface RouteMatch {
  tab: string
  params: Record<string, string>
  query: Record<string, string>
  path: string
}

export function parseHashPath(hashValue: string): { path: string; query: Record<string, string> } {
  const hash = hashValue.startsWith('#') ? hashValue.slice(1) : hashValue
  const normalized = hash || '/'
  const queryIndex = normalized.indexOf('?')
  const path = queryIndex >= 0 ? normalized.slice(0, queryIndex) || '/' : normalized
  const search = queryIndex >= 0 ? normalized.slice(queryIndex + 1) : ''
  const query: Record<string, string> = {}

  for (const [key, value] of new URLSearchParams(search).entries()) {
    query[key] = value
  }

  return { path, query }
}

export function buildHashPath(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }

  const search = params.toString()
  return search ? `${path}?${search}` : path
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
  const parsed = parseHashPath(hash)
  for (const tab of tabs) {
    if (!tab.path) continue
    const match = matchPath(tab.path, parsed.path)
    if (match) return { tab: tab.id, params: match.params, query: parsed.query, path: hash }
  }
  return { tab: tabs[0]?.id || '', params: {}, query: parsed.query, path: hash }
}

export function navigate(path: string) {
  location.hash = '#' + path
}
