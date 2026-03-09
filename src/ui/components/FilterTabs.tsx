const RUN_FILTERS = ['all', 'running', 'idle', 'completed', 'errored']

export function FilterTabs({ active, onChange }: { active: string; onChange: (f: string) => void }) {
  return (
    <div class="tabs mb-4">
      {RUN_FILTERS.map((f) => (
        <button key={f} class={`tab ${active === f ? 'active' : ''}`} onClick={() => onChange(f)}>
          {f.charAt(0).toUpperCase() + f.slice(1)}
        </button>
      ))}
    </div>
  )
}
