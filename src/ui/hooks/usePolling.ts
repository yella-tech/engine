import { useEffect, useRef } from 'preact/hooks'

export function usePolling(fn: () => void | Promise<void>, ms: number, enabled: boolean) {
  const saved = useRef(fn)
  useEffect(() => {
    saved.current = fn
  }, [fn])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        await saved.current()
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick()
          }, ms)
        }
      }
    }

    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [ms, enabled])
}
