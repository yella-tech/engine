export function Pagination({
  offset,
  pageSize,
  total,
  onPrev,
  onNext,
}: {
  offset: number
  pageSize: number
  total: number
  onPrev: () => void
  onNext: () => void
}) {
  if (total <= 0) return null
  const from = offset + 1
  const to = Math.min(offset + pageSize, total)
  return (
    <div style="display:flex;margin-top:var(--space-3);align-items:center;gap:var(--space-3);flex-wrap:wrap">
      <button class="btn btn-sm" disabled={offset === 0} onClick={onPrev}>
        ← Prev
      </button>
      <span class="label-muted" style="margin:0">
        {from}–{to} of {total}
      </span>
      <button class="btn btn-sm" disabled={offset + pageSize >= total} onClick={onNext}>
        Next →
      </button>
    </div>
  )
}
