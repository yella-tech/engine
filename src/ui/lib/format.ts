import { getRunStatus } from '../../status.js'

export function shortId(id: string) {
  return id && id.length > 12 ? id.slice(0, 8) + '...' : id || '--'
}

export function formatUptime(seconds: number) {
  if (!seconds && seconds !== 0) return '--'
  const hr = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return (hr > 0 ? hr + 'h ' : '') + (m > 0 ? m + 'm ' : '') + s + 's'
}

export function formatJson(obj: unknown) {
  if (obj === null || obj === undefined) return 'null'
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

export function timeAgo(epochMs: number) {
  if (!epochMs) return '--'
  const diff = Date.now() - epochMs
  if (diff < 1000) return 'just now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return s + 's ago'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const hr = Math.floor(m / 60)
  if (hr < 24) return hr + 'h ago'
  return Math.floor(hr / 24) + 'd ago'
}

export function timeStr() {
  return new Date().toTimeString().slice(0, 8)
}

export function formatPercent(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatDurationMs(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`
  const minutes = seconds / 60
  return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`
}

export function stripEffectPrefix(key: string) {
  if (key.startsWith('str:')) return key.slice(4)
  if (key.startsWith('arr:v1:')) {
    try {
      return JSON.parse(key.slice(7)).join(' / ')
    } catch {
      return key.slice(7)
    }
  }
  return key
}

export function runStatus(run: any) {
  if (!run) return 'idle'
  return run.status ?? getRunStatus(run)
}

export function isDeferred(run: any) {
  return runStatus(run) === 'deferred'
}
