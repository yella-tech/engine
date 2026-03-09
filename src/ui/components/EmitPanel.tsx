import { useEffect, useRef } from 'preact/hooks'

export interface EmitState {
  eventName: string
  payload: string
  idempotencyKey: string
  result: { ok: boolean; text: string } | null
  submitting: boolean
  focusPayload: boolean
}

export function EmitPanel({
  emit,
  onUpdate,
  onSubmit,
}: {
  emit: EmitState
  onUpdate: (patch: Partial<EmitState>) => void
  onSubmit: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.target as HTMLTextAreaElement
      const start = ta.selectionStart
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(ta.selectionEnd)
      ta.selectionStart = ta.selectionEnd = start + 2
      onUpdate({ payload: ta.value })
    }
  }

  useEffect(() => {
    if (emit.focusPayload && textareaRef.current) {
      textareaRef.current.focus()
      onUpdate({ focusPayload: false })
    }
  }, [emit.focusPayload])

  return (
    <div class="stack" style="max-width:600px">
      <div class="field">
        <span class="label">Event Name</span>
        <input class="input" type="text" value={emit.eventName} onInput={(e) => onUpdate({ eventName: (e.target as HTMLInputElement).value })} placeholder="e.g. email:new" spellcheck={false} />
      </div>
      <div class="field">
        <span class="label">Payload (JSON)</span>
        <textarea ref={textareaRef} class="textarea" spellcheck={false} style="height:180px" value={emit.payload} onInput={(e) => onUpdate({ payload: (e.target as HTMLTextAreaElement).value })} onKeyDown={onKeyDown}></textarea>
      </div>
      <div class="field">
        <span class="label">Idempotency Key (optional)</span>
        <input class="input" type="text" value={emit.idempotencyKey} onInput={(e) => onUpdate({ idempotencyKey: (e.target as HTMLInputElement).value })} placeholder="leave empty for none" spellcheck={false} />
      </div>
      <button class="btn btn-primary" disabled={emit.submitting} onClick={onSubmit}>
        Emit Event
      </button>
      {emit.result && <div class={`emit-result ${emit.result.ok ? 'success' : 'error'}`}>{emit.result.text}</div>}
    </div>
  )
}
