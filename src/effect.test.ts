import { describe, it, expect, beforeEach } from 'vitest'
import { createEffectStore } from './effect.js'
import type { EffectStore } from './types.js'

describe('createEffectStore (memory)', () => {
  let store: EffectStore

  beforeEach(() => {
    store = createEffectStore()
  })

  it('getEffect returns null for unknown effect', () => {
    expect(store.getEffect('run-1', 'key-1')).toBeNull()
  })

  it('markStarted creates a started record', () => {
    store.markStarted('run-1', 'send-email')
    const record = store.getEffect('run-1', 'send-email')
    expect(record).not.toBeNull()
    expect(record!.state).toBe('started')
    expect(record!.runId).toBe('run-1')
    expect(record!.effectKey).toBe('send-email')
    expect(record!.output).toBeNull()
    expect(record!.error).toBeNull()
    expect(record!.startedAt).toBeGreaterThan(0)
    expect(record!.completedAt).toBeNull()
  })

  it('markCompleted transitions started to completed with output', () => {
    store.markStarted('run-1', 'charge')
    store.markCompleted('run-1', 'charge', { chargeId: 'ch_123' })
    const record = store.getEffect('run-1', 'charge')!
    expect(record.state).toBe('completed')
    expect(record.output).toEqual({ chargeId: 'ch_123' })
    expect(record.completedAt).toBeGreaterThan(0)
  })

  it('markFailed transitions started to failed with error', () => {
    store.markStarted('run-1', 'webhook')
    store.markFailed('run-1', 'webhook', 'connection refused')
    const record = store.getEffect('run-1', 'webhook')!
    expect(record.state).toBe('failed')
    expect(record.error).toBe('connection refused')
    expect(record.completedAt).toBeGreaterThan(0)
  })

  it('effects are scoped per run', () => {
    store.markStarted('run-1', 'key')
    store.markStarted('run-2', 'key')
    store.markCompleted('run-1', 'key', 'output-1')
    const r1 = store.getEffect('run-1', 'key')!
    const r2 = store.getEffect('run-2', 'key')!
    expect(r1.state).toBe('completed')
    expect(r2.state).toBe('started')
  })

  it('markStarted overwrites a previously started record (crash recovery)', () => {
    store.markStarted('run-1', 'key')
    const first = store.getEffect('run-1', 'key')!
    store.markStarted('run-1', 'key')
    const second = store.getEffect('run-1', 'key')!
    expect(second.state).toBe('started')
    expect(second.startedAt).toBeGreaterThanOrEqual(first.startedAt)
  })
})
