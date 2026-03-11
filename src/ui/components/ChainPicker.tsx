import { useState } from 'preact/hooks'

export interface ChainOption {
  id: string
  label: string
}

export function ChainPicker({
  label,
  placeholder,
  emptyLabel,
  options,
  selectedId,
  onChange,
}: {
  label: string
  placeholder: string
  emptyLabel: string
  options: ChainOption[]
  selectedId: string
  onChange: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const selected = options.find((option) => option.id === selectedId) || null
  const filtered = options.filter((option) => {
    if (!needle) return true
    return option.label.toLowerCase().includes(needle)
  })

  return (
    <div class="chain-picker">
      <div class="chain-picker-head">
        <span class="label">{label}</span>
        <span class="label-muted">{options.length} chain{options.length === 1 ? '' : 's'}</span>
      </div>
      <div class="chain-picker-toolbar">
        <input
          class="input chain-picker-input"
          type="text"
          value={query}
          placeholder={placeholder}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          spellcheck={false}
        />
        {selectedId && (
          <button
            class="btn btn-sm chain-picker-clear"
            onClick={() => {
              setQuery('')
              onChange('')
            }}
          >
            Clear
          </button>
        )}
      </div>
      {selected && (
        <div class="chain-picker-selected">
          <span class="label-muted">Selected</span>
          <span class="chain-picker-selected-label">{selected.label}</span>
        </div>
      )}
      <div class="chain-picker-list" role="listbox" aria-label={label}>
        {!filtered.length && <div class="chain-picker-empty">{emptyLabel}</div>}
        {filtered.slice(0, 12).map((option) => (
          <button
            key={option.id}
            class={`chain-picker-option ${option.id === selectedId ? 'active' : ''}`}
            onClick={() => {
              setQuery('')
              onChange(option.id)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
