const RUN_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'completed', label: 'Completed' },
  { value: 'errored', label: 'Errored' },
  { value: 'dead-letter', label: 'DLQ' },
]

export function FilterTabs({ active, onChange }: { active: string; onChange: (f: string) => void }) {
  return (
    <select class="select" value={active} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} style={{ width: 'auto' }}>
      {RUN_FILTERS.map((filter) => (
        <option key={filter.value} value={filter.value}>
          {filter.label}
        </option>
      ))}
    </select>
  )
}
