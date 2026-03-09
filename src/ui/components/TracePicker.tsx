export function TracePicker({
  options,
  selectedId,
  onChange,
}: {
  options: { id: string; label: string }[]
  selectedId: string
  onChange: (id: string) => void
}) {
  return (
    <div class="field mb-5">
      <span class="label">Select a completed chain to trace</span>
      <select class="select" value={selectedId} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        <option value="">-- select a run --</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
