import { useEffect, useRef } from 'preact/hooks'

export function useEventStream<T = unknown>(
  url: string,
  onEvent: (event: T) => void,
  enabled: boolean,
) {
  const saved = useRef(onEvent)

  useEffect(() => {
    saved.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!enabled) return
    if (typeof EventSource === 'undefined') return

    const source = new EventSource(url)
    source.onmessage = (message) => {
      try {
        saved.current(JSON.parse(message.data) as T)
      } catch {
        /* ignore malformed events */
      }
    }

    return () => {
      source.close()
    }
  }, [url, enabled])
}
