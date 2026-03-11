import { Badge } from './Badge'
import { compressTimeline } from '../lib/compress'
import { runStatus } from '../lib/format'

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function GanttChart({ trace, onSpanClick }: { trace: any; onSpanClick: (id: string) => void }) {
  if (!trace || !trace.spans || !trace.spans.length) return null

  const { spans, minTime, durationMs, executionDurationMs, pausedDurationMs, gaps: traceGaps = [] } = trace
  const { map, totalCompressed, gaps } = compressTimeline(spans, minTime, durationMs, traceGaps)

  const longest = Math.max(...spans.map((s: any) => s.processName.length))
  const labelW = Math.max(240, longest * 10 + 130)

  const tickCount = 6
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => Math.round((i / tickCount) * totalCompressed))

  return (
    <div class="gantt" style={`--gantt-label-w:${labelW}px`}>
      <div class="gantt-header">
        <span class="label" style="margin:0;color:var(--white)">
          Trace, {spans.length} span{spans.length > 1 ? 's' : ''}
          {traceGaps.length ? `, ${traceGaps.length} deferred gap${traceGaps.length > 1 ? 's' : ''} collapsed` : gaps.length ? `, ${gaps.length} gap${gaps.length > 1 ? 's' : ''} collapsed` : ''}
        </span>
        <span class="label-muted" style="margin:0;color:var(--accent)">
          Visible: {formatDuration(totalCompressed)}
          {executionDurationMs !== undefined && executionDurationMs !== totalCompressed ? `, span time: ${formatDuration(executionDurationMs)}` : ''}
          {pausedDurationMs ? `, paused: ${formatDuration(pausedDurationMs)}` : ''}
          {durationMs !== totalCompressed ? ` (wall: ${formatDuration(durationMs)})` : ''}
        </span>
      </div>
      <div class="gantt-ruler">
        {ticks.map((ms) => (
          <span key={ms}>{ms}ms</span>
        ))}
      </div>
      {spans.map((span: any) => {
        const status = runStatus(span)
        const idlePos = span.idleAt !== null ? map(span.idleAt) : 0
        const runningPos = span.runningAt !== null ? map(span.runningAt) : idlePos
        const endPos = span.completedAt !== null ? map(span.completedAt) : 100
        const spanGaps = traceGaps.filter((gap: any) => gap.parentRunId === span.id)

        const idleWidth = runningPos - idlePos
        const activeWidth = Math.max(endPos - runningPos, 0.5)
        const activeDuration = span.runningAt !== null && span.completedAt !== null ? span.completedAt - span.runningAt : null

        return (
          <div key={span.id} class="gantt-row" onClick={() => onSpanClick(span.id)}>
            <div class="gantt-label">
              <span class="gantt-label-name">{span.processName}</span>
              <Badge state={status} />
            </div>
            <div class="gantt-track">
              {idleWidth > 0.1 && <div class="gantt-bar gantt-bar-idle" style={`left:${idlePos}%;width:${idleWidth}%`}></div>}
              <div class={`gantt-bar gantt-bar-active ${status}`} style={`left:${runningPos}%;width:${activeWidth}%`}>
                {activeDuration !== null && <span class="gantt-bar-duration">{activeDuration}ms</span>}
              </div>
              {spanGaps.map((gap: any) => {
                const startPos = map(gap.start)
                const endPos = map(gap.end)
                const width = Math.max(endPos - startPos, 0.5)
                const markerPos = startPos + width / 2

                return (
                  <>
                    <div class="gantt-gap-line" style={`left:${startPos}%;width:${width}%`}></div>
                    <div class="gantt-gap-marker" style={`left:${markerPos}%`}>
                      {'\u23F8'} {formatDuration(gap.durationMs)}
                    </div>
                  </>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
