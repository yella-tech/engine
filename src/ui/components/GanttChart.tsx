import { Badge } from './Badge'
import { compressTimeline } from '../lib/compress'

export function GanttChart({ trace, onSpanClick }: { trace: any; onSpanClick: (id: string) => void }) {
  if (!trace || !trace.spans || !trace.spans.length) return null

  const { spans, minTime, durationMs } = trace
  const { map, totalCompressed, gaps } = compressTimeline(spans, minTime, durationMs)

  const longest = Math.max(...spans.map((s: any) => s.processName.length))
  const labelW = Math.max(240, longest * 10 + 130)

  const tickCount = 6
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((i / tickCount) * totalCompressed))

  return (
    <div class="gantt" style={`--gantt-label-w:${labelW}px`}>
      <div class="gantt-header">
        <span class="label" style="margin:0;color:var(--white)">
          Trace — {spans.length} span{spans.length > 1 ? 's' : ''}
          {gaps.length ? ` — ${gaps.length} gap${gaps.length > 1 ? 's' : ''} collapsed` : ''}
        </span>
        <span class="label-muted" style="margin:0;color:var(--accent)">
          Total: {totalCompressed}ms{gaps.length ? ` (wall: ${durationMs}ms)` : ''}
        </span>
      </div>
      <div class="gantt-ruler">
        {ticks.map((ms) => (
          <span key={ms}>{ms}ms</span>
        ))}
      </div>
      {spans.map((span: any) => {
        const idlePos = span.idleAt !== null ? map(span.idleAt) : 0
        const runningPos = span.runningAt !== null ? map(span.runningAt) : idlePos
        const endPos = span.completedAt !== null ? map(span.completedAt) : 100

        const idleWidth = runningPos - idlePos
        const activeWidth = Math.max(endPos - runningPos, 0.5)
        const activeDuration = span.runningAt !== null && span.completedAt !== null ? span.completedAt - span.runningAt : null

        return (
          <div key={span.id} class="gantt-row" onClick={() => onSpanClick(span.id)}>
            <div class="gantt-label">
              <span class="gantt-label-name">{span.processName}</span>
              <Badge state={span.state} />
            </div>
            <div class="gantt-track">
              {idleWidth > 0.1 && <div class="gantt-bar gantt-bar-idle" style={`left:${idlePos}%;width:${idleWidth}%`}></div>}
              <div class={`gantt-bar gantt-bar-active ${span.state}`} style={`left:${runningPos}%;width:${activeWidth}%`}>
                {activeDuration !== null && <span class="gantt-bar-duration">{activeDuration}ms</span>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
