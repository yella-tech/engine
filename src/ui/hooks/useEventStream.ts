type SharedEventListener = (message: string) => void

type SharedEventSource = {
  source: EventSource
  listeners: Set<SharedEventListener>
}

const sharedSources = new Map<string, SharedEventSource>()

function subscribe(url: string, listener: SharedEventListener): () => void {
  let shared = sharedSources.get(url)
  if (!shared) {
    const source = new EventSource(url)
    const listeners = new Set<SharedEventListener>()
    shared = { source, listeners }
    source.onmessage = (message) => {
      for (const currentListener of listeners) {
        currentListener(message.data)
      }
    }
    sharedSources.set(url, shared)
  }

  shared.listeners.add(listener)

  return () => {
    const current = sharedSources.get(url)
    if (!current) return
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return
    current.source.close()
    sharedSources.delete(url)
  }
}

export function subscribeToJsonEventStream<T = unknown>(url: string, listener: (event: T) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}

  return subscribe(url, (message) => {
    try {
      listener(JSON.parse(message) as T)
    } catch {
      /* ignore malformed events */
    }
  })
}
