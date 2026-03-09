import { Badge, DeferredBadge } from './Badge'
import { DetailRow } from './DetailRow'
import { Timeline } from './Timeline'
import { StepDetail } from './StepDetail'
import { usePolling } from '../hooks/usePolling'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { shortId, isDeferred } from '../lib/format'

export interface OverlayState {
  open: boolean
  runId: string | null
  run: any
  chain: any[]
  selectedStepIdx: number
  stepDetail: { run: any; effects: any[] }
}

export interface OverlayActions {
  openOverlay: (id: string) => void
  closeOverlay: () => void
  refreshOverlay: (id: string) => void
  selectStep: (idx: number) => void
  retryStep: (id: string) => void
  requeueStep: (id: string) => void
  reemitStep: (event: string, payload: unknown) => void
  resumeStep?: (id: string) => void
  viewInTrace?: (rootId: string) => void
  viewInGraph?: (rootId: string) => void
}

export function RunOverlay({ overlay, actions }: { overlay: OverlayState; actions: OverlayActions }) {
  const { open, runId, run, chain, selectedStepIdx, stepDetail } = overlay

  usePolling(
    async () => {
      if (!runId) return
      await actions.refreshOverlay(runId)
    },
    1500,
    open && chain.some((c: any) => c.state !== 'completed' && c.state !== 'errored'),
  )

  useEscapeKey(() => {
    if (open) actions.closeOverlay()
  })

  if (!open) return <div class="run-overlay"></div>

  const rootRun = chain.find((c: any) => c.parentRunId === null) || chain[0]

  return (
    <div class="run-overlay open">
      <div class="overlay-header">
        <span style="font-weight:700;text-transform:uppercase;letter-spacing:var(--tracking-wide);font-size:var(--text-sm)">Run {shortId(runId!)}</span>
        <button class="modal-close" style="border-color:var(--white);color:var(--white)" onClick={actions.closeOverlay}>
          ×
        </button>
      </div>
      <div class="overlay-body">
        {run ? (
          <>
            <DetailRow label="ID">{run.id}</DetailRow>
            <DetailRow label="Process">{run.processName}</DetailRow>
            <DetailRow label="Event">{run.eventName}</DetailRow>
            <DetailRow label="State">
              <Badge state={run.state} />
              {isDeferred(run) && (
                <>
                  {' '}
                  <DeferredBadge />
                </>
              )}
            </DetailRow>
            <DetailRow label="Correlation">{shortId(run.correlationId)}</DetailRow>
          </>
        ) : (
          <div class="empty">Loading...</div>
        )}

        {chain.length > 0 && (
          <>
            <div class="label mt-5 mb-3">Timeline</div>
            <Timeline chain={chain} selectedIdx={selectedStepIdx} onSelect={(i) => actions.selectStep(i)} />
          </>
        )}

        {stepDetail.run && (
          <StepDetail run={stepDetail.run} effects={stepDetail.effects} onRetry={actions.retryStep} onRequeue={actions.requeueStep} onReemit={actions.reemitStep} onResume={actions.resumeStep} />
        )}

        {rootRun && (
          <div style="display:flex;gap:var(--space-3);margin-top:var(--space-4)">
            {actions.viewInTrace && (
              <button class="btn btn-sm" onClick={() => actions.viewInTrace!(rootRun.id)}>
                View in Trace
              </button>
            )}
            {actions.viewInGraph && (
              <button class="btn btn-sm" onClick={() => actions.viewInGraph!(rootRun.id)}>
                View Graph
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
