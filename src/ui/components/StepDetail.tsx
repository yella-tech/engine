import { Badge, DeferredBadge } from './Badge'
import { JsonBlock } from './JsonBlock'
import { DetailRow } from './DetailRow'
import { EffectsList } from './EffectsList'
import { isDeferred } from '../lib/format'

export function StepDetail({
  run,
  effects,
  onRetry,
  onRequeue,
  onReemit,
  onResume,
}: {
  run: any
  effects: any[]
  onRetry: (id: string) => void
  onRequeue: (id: string) => void
  onReemit: (event: string, payload: unknown) => void
  onResume?: (id: string) => void
}) {
  if (!run) return <div class="empty">Select a step</div>

  const deferred = isDeferred(run)

  return (
    <div class="step-detail">
      <div class="step-detail-header">
        <span class="step-detail-title">{run.processName}</span>
        <div style="display:flex;gap:var(--space-2);align-items:center">
          <Badge state={run.state} />
          {deferred && <DeferredBadge />}
        </div>
      </div>

      <DetailRow label="Payload">
        <JsonBlock data={run.payload} />
      </DetailRow>

      <EffectsList effects={effects} />

      {run.state === 'errored' && run.result?.error && (
        <DetailRow label="Error">
          <JsonBlock data={run.result.error} />
        </DetailRow>
      )}

      {deferred && (
        <DetailRow label="Awaiting">
          <span style="font-weight:700">{run.result.triggerEvent}</span>
          <span class="label-muted" style="display:inline;margin-left:var(--space-2)">
            chain paused
          </span>
        </DetailRow>
      )}

      {run.context && Object.keys(run.context).length > 0 && (
        <DetailRow label="Context">
          <JsonBlock data={run.context} />
        </DetailRow>
      )}

      <div class="step-actions">
        {deferred && onResume && (
          <button class="btn btn-sm btn-resume" onClick={() => onResume(run.id)}>
            ▶ Resume
          </button>
        )}
        {run.state === 'errored' && (
          <>
            <button class="btn btn-sm" onClick={() => onRetry(run.id)}>
              Retry
            </button>
            <button class="btn btn-sm" onClick={() => onRequeue(run.id)}>
              Requeue
            </button>
          </>
        )}
        <button class="btn btn-sm" onClick={() => onReemit(run.eventName, run.payload)}>
          Re-emit
        </button>
      </div>
    </div>
  )
}
