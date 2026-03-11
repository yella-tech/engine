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
    <div class="tabs mb-4">
      {RUN_FILTERS.map((filter) => (
        <button key={filter.value} class={`tab ${active === filter.value ? 'active' : ''}`} onClick={() => onChange(filter.value)}>
          {filter.label}
        </button>
      ))}
    </div>
  )
}
