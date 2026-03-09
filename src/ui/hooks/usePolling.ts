import { useEffect, useRef } from 'preact/hooks'

export function usePolling(fn: () => void, ms: number, enabled: boolean) {
  const saved = useRef(fn)
  useEffect(() => {
    saved.current = fn
  })
  useEffect(() => {
    if (!enabled) return
    saved.current()
    const id = setInterval(() => saved.current(), ms)
    return () => clearInterval(id)
  }, [ms, enabled])
}
