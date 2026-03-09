export interface CompressedTimeline {
  map: (t: number) => number
  totalCompressed: number
  gaps: { start: number; end: number; size: number }[]
}

export function compressTimeline(spans: any[], minTime: number, durationMs: number): CompressedTimeline {
  const GAP_THRESHOLD = 500 // ms - gaps larger than this get collapsed
  const GAP_DISPLAY = 40 // ms - collapsed gaps show as this width

  // Collect all timestamps and sort
  const events: number[] = []
  for (const s of spans) {
    if (s.idleAt !== null) events.push(s.idleAt)
    if (s.runningAt !== null) events.push(s.runningAt)
    if (s.completedAt !== null) events.push(s.completedAt)
  }
  events.sort((a, b) => a - b)
  if (!events.length) return { map: () => 0, totalCompressed: 1, gaps: [] }

  // Find gaps between consecutive event clusters
  const gaps: { start: number; end: number; size: number }[] = []
  for (let i = 1; i < events.length; i++) {
    const gap = events[i] - events[i - 1]
    if (gap > GAP_THRESHOLD) {
      gaps.push({ start: events[i - 1], end: events[i], size: gap })
    }
  }

  const totalRemoved = gaps.reduce((sum, g) => sum + (g.size - GAP_DISPLAY), 0)
  const totalCompressed = Math.max(durationMs - totalRemoved, 1)

  // Map a real timestamp to compressed position (0-100%)
  function map(t: number) {
    let offset = t - minTime
    for (const g of gaps) {
      if (t > g.start) {
        const overlap = Math.min(t, g.end) - g.start
        offset -= Math.max(overlap - GAP_DISPLAY, 0)
      }
    }
    return (offset / totalCompressed) * 100
  }

  return { map, totalCompressed, gaps }
}
