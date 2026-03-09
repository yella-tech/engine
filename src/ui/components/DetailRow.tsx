import type { ComponentChildren } from 'preact'

export function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="detail-row">
      <div class="detail-key label-muted">{label}</div>
      <div class="detail-val">{children}</div>
    </div>
  )
}
