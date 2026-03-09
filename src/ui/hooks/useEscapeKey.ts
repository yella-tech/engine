import { useEffect, useRef } from 'preact/hooks'

export function useEscapeKey(handler: () => void) {
  const saved = useRef(handler)
  useEffect(() => {
    saved.current = handler
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') saved.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
