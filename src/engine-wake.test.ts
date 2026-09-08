import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from './index.js'

describe('delayed retries survive restart (SQLite)', () => {
  let tmpFile: string
  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  })

  it('a run backing off when the process stops is retried by the next process', async () => {
    tmpFile = path.join(os.tmpdir(), `state-wake-restart-${Date.now()}.db`)
    let calls = 0
    let firstFailed!: () => void
    const failed = new Promise<void>((r) => (firstFailed = r))

    const engine1 = createEngine({ store: { type: 'sqlite', path: tmpFile }, retry: { maxRetries: 3, delay: 300 } })
    engine1.register('proc', 'go', async () => {
      calls++
      if (calls === 1) {
        queueMicrotask(firstFailed)
        throw new Error('transient')
      }
      return { success: true }
    })
    engine1.emit('go', {})
    await failed
    await new Promise((r) => setTimeout(r, 20))
    await engine1.stop()
    expect(calls).toBe(1)

    const engine2 = createEngine({ store: { type: 'sqlite', path: tmpFile }, retry: { maxRetries: 3, delay: 300 } })
    engine2.register('proc', 'go', async () => {
      calls++
      return { success: true }
    })
    engine2.start()
    await engine2.drain(2000)
    expect(calls).toBe(2)
    expect(engine2.getCompleted()).toHaveLength(1)
    await engine2.stop()
  })
})

describe('onIdle wake hint', () => {
  let engine: ReturnType<typeof createEngine>
  afterEach(async () => {
    await engine?.stop()
  })

  it('reports the pending retry time when a run is backing off, then null once quiet', async () => {
    const hints: (number | null)[] = []
    let calls = 0
    engine = createEngine({
      store: { type: 'memory' },
      retry: { maxRetries: 1, delay: 150 },
      onIdle: (nextWakeAt) => hints.push(nextWakeAt),
    })
    engine.register('proc', 'go', async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return { success: true }
    })
    const before = Date.now()
    engine.emit('go', {})
    await engine.drain(2000)
    await new Promise((r) => setTimeout(r, 10))

    expect(hints.length).toBeGreaterThanOrEqual(2)
    const first = hints[0]
    expect(first).not.toBeNull()
    expect(first!).toBeGreaterThanOrEqual(before + 100)
    expect(first!).toBeLessThanOrEqual(before + 400)
    expect(hints[hints.length - 1]).toBeNull()
  })

  it('reports null when a run completes and nothing else is pending', async () => {
    const hints: (number | null)[] = []
    engine = createEngine({ store: { type: 'memory' }, onIdle: (n) => hints.push(n) })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', {})
    await engine.drain(2000)
    await new Promise((r) => setTimeout(r, 10))
    expect(hints).toEqual([null])
  })
})
