import { useEffect, useRef } from 'preact/hooks'

export function usePolling(fn: () => void | Promise<void>, ms: number, enabled: boolean, opts?: { immediate?: boolean }) {
  const saved = useRef(fn)
  const immediate = opts?.immediate ?? true
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

    if (immediate) {
      void tick()
    } else {
      timer = setTimeout(() => {
        void tick()
      }, ms)
    }

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [ms, enabled, immediate])
}
