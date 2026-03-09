import type { ComponentChildren } from 'preact'

export function TickerMsg({ time, children }: { time: string; children: ComponentChildren }) {
  return (
    <span class="ticker-msg">
      <span class="t-time">{time}</span> {children}
    </span>
  )
}

export function Ticker({ messages }: { messages: ComponentChildren[] }) {
  const inner = messages.length ? (
    messages.map((m, i) => (
      <span key={i}>
        {i > 0 ? ' \u00b7 ' : ''}
        {m}
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
