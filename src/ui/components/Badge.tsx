export function Badge({ state }: { state: string }) {
  const label = state === 'dead-letter' ? 'dlq' : state
  return <span class={`badge badge-${state}`}>{label}</span>
}

export function DeferredBadge() {
  return <span class="badge badge-deferred">deferred</span>
}
