import { Badge } from './Badge'
import { runStatus } from '../lib/format'

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
    const status = runStatus(run)
    if (status === 'deferred') return '\u23F8'
    return status === 'completed' ? '\u2713' : status === 'errored' || status === 'dead-letter' ? '\u2717' : status === 'running' ? '\u25B6' : '\u25CF'
  }

  return (
    <div class="timeline">
      {chain.map((c: any, i: number) => (
        <div key={c.id} class={`timeline-step ${i === selectedIdx ? 'selected' : ''}`} onClick={() => onSelect(i)}>
          <span class="timeline-step-num">{i + 1}</span>
          <span class={`timeline-step-dot ${runStatus(c)}`}></span>
          <span class="timeline-step-name">{c.processName}</span>
          <Badge state={runStatus(c)} />
          <span class="timeline-step-icon">{stateIcon(c)}</span>
        </div>
      ))}
    </div>
  )
}
