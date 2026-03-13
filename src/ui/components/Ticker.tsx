import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

const MAX_TICKER_MESSAGES = 20
const TICKER_BATCH_WINDOW_MS = 750

export function TickerMsg({ time, children }: { time: string; children: ComponentChildren }) {
  return (
    <span class="ticker-msg">
      <span class="t-time">{time}</span> {children}
    </span>
  )
}

type TickerEntry = {
  id: number
  node: ComponentChildren
}

export function Ticker({ bindPush }: { bindPush?: (push: (message: ComponentChildren) => void) => void }) {
  const [messages, setMessages] = useState<TickerEntry[]>([])
  const nextIdRef = useRef(1)
  const pendingRef = useRef<TickerEntry[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPending = useCallback(() => {
    flushTimerRef.current = null
    if (pendingRef.current.length === 0) return
    const pending = pendingRef.current
    pendingRef.current = []
    setMessages((prev) => [...pending].reverse().concat(prev).slice(0, MAX_TICKER_MESSAGES))
  }, [])

  useEffect(() => {
    if (!bindPush) return

    bindPush((message) => {
      pendingRef.current.push({ id: nextIdRef.current++, node: message })
      if (pendingRef.current.length > MAX_TICKER_MESSAGES) {
        pendingRef.current.splice(0, pendingRef.current.length - MAX_TICKER_MESSAGES)
      }
      if (flushTimerRef.current) return
      flushTimerRef.current = setTimeout(() => {
        flushPending()
      }, TICKER_BATCH_WINDOW_MS)
    })

    return () => {
      bindPush(() => {})
    }
  }, [bindPush, flushPending])

  useEffect(() => () => {
    pendingRef.current = []
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [])

  const inner = messages.length ? (
    messages.map((message, index) => (
      <span key={message.id}>
        {index > 0 ? ' \u00b7 ' : ''}
        {message.node}
      </span>
    ))
  ) : (
    <span class="ticker-msg">
      <span class="t-time">--:--:--</span> waiting for events...
    </span>
  )
  return (
    <div class="ticker">
      <span class="ticker-label">Activity</span>
      <div class="ticker-messages">{inner}</div>
    </div>
  )
}
