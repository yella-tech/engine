import { Badge, DeferredBadge } from './Badge'
import { isDeferred } from '../lib/format'

export function Timeline({
  chain,
  selectedIdx,
  onSelect,
}: {
  chain: any[]
  selectedIdx: number
  onSelect: (i: number) => void
}) {
  const stateIcon = (run: any) => {
    if (isDeferred(run)) return '\u23F8'
    const state = run.state
    return state === 'completed' ? '\u2713' : state === 'errored' ? '\u2717' : state === 'running' ? '\u25B6' : '\u25CF'
  }

  return (
    <div class="timeline">
      {chain.map((c: any, i: number) => (
        <div key={c.id} class={`timeline-step ${i === selectedIdx ? 'selected' : ''}`} onClick={() => onSelect(i)}>
          <span class="timeline-step-num">{i + 1}</span>
          <span class={`timeline-step-dot ${isDeferred(c) ? 'deferred' : c.state}`}></span>
          <span class="timeline-step-name">{c.processName}</span>
          {isDeferred(c) ? <DeferredBadge /> : <Badge state={c.state} />}
          <span class="timeline-step-icon">{stateIcon(c)}</span>
        </div>
      ))}
    </div>
  )
}
