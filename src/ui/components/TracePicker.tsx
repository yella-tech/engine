import { ChainPicker } from './ChainPicker'

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
    <ChainPicker
      label="Select a completed chain to trace"
      placeholder="Filter by process, event, or time"
      emptyLabel="No chains match that filter"
      options={options}
      selectedId={selectedId}
      onChange={onChange}
    />
  )
}
