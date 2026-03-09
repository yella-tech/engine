import { useState } from 'preact/hooks'
import { Badge } from './Badge'
import { JsonBlock } from './JsonBlock'
import { DetailRow } from './DetailRow'
import { stripEffectPrefix } from '../lib/format'

function EffectItem({ effect }: { effect: any }) {
  const [open, setOpen] = useState(false)
  const displayKey = stripEffectPrefix(effect.effectKey)
  const hasOutput = effect.output !== null || effect.error
  return (
    <div class="effect-item">
      <span class="effect-key">{displayKey}</span>
      <Badge state={effect.state} />
      {hasOutput && (
        <>
          <span class="effect-toggle" onClick={() => setOpen(!open)}>
            {open ? '[hide]' : '[show]'}
          </span>
          <div class={`effect-output ${open ? 'open' : ''}`}>
            <JsonBlock data={effect.error || effect.output} />
          </div>
        </>
      )}
    </div>
  )
}

export function EffectsList({ effects }: { effects: any[] }) {
  if (!effects || !effects.length) return null
  return (
    <DetailRow label="Effects">
      <div class="effects-list">
        {effects.map((ef: any, i: number) => (
          <EffectItem key={i} effect={ef} />
        ))}
      </div>
    </DetailRow>
  )
}
