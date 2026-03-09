export function Badge({ state }: { state: string }) {
  return <span class={`badge badge-${state}`}>{state}</span>
}

export function DeferredBadge() {
  return <span class="badge badge-deferred">deferred</span>
}
