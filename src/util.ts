export function safeCallHook<Args extends unknown[]>(fn: ((...args: Args) => void) | undefined, args: Args, onError?: (error: unknown, context: string) => void, context?: string): void {
  if (!fn) return
  try {
    fn(...args)
  } catch (err) {
    onError?.(err, context ?? 'hook')
  }
}

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

export function parseDurationMs(value: number | string, optionName: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${optionName} must be a positive number of milliseconds`)
    }
    return value
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
  if (!match) {
    throw new Error(`${optionName} must be a positive duration like "500ms", "30s", "5m", "2h", or "30d"`)
  }

  const amount = Number(match[1])
  const unit = match[2] as keyof typeof DURATION_UNITS
  const durationMs = amount * DURATION_UNITS[unit]
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${optionName} must be greater than 0`)
  }
  return durationMs
}
