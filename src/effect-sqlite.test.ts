import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteStores } from './run-sqlite.js'
import type { EffectStore } from './types.js'

describe('SQLite EffectStore', () => {
  let effectStore: EffectStore
  let close: () => void

  beforeEach(() => {
    const stores = createSqliteStores(':memory:')
    effectStore = stores.effectStore
    close = stores.close
  })

  afterEach(() => {
    close()
  })

  it('getEffect returns null for unknown effect', () => {
    expect(effectStore.getEffect('run-1', 'key-1')).toBeNull()
  })

  it('markStarted creates a started record', () => {
    effectStore.markStarted('run-1', 'send-email')
    const record = effectStore.getEffect('run-1', 'send-email')
    expect(record).not.toBeNull()
    expect(record!.state).toBe('started')
    expect(record!.output).toBeNull()
  })

  it('markCompleted stores output', () => {
    effectStore.markStarted('run-1', 'charge')
    effectStore.markCompleted('run-1', 'charge', { chargeId: 'ch_123' })
    const record = effectStore.getEffect('run-1', 'charge')!
    expect(record.state).toBe('completed')
    expect(record.output).toEqual({ chargeId: 'ch_123' })
  })

  it('markFailed stores error', () => {
    effectStore.markStarted('run-1', 'webhook')
    effectStore.markFailed('run-1', 'webhook', 'timeout')
    const record = effectStore.getEffect('run-1', 'webhook')!
    expect(record.state).toBe('failed')
    expect(record.error).toBe('timeout')
  })

  it('clearStartedEffects removes only started rows for the run', () => {
    effectStore.markStarted('run-1', 'started')
    effectStore.markStarted('run-1', 'will-complete')
    effectStore.markCompleted('run-1', 'will-complete', 'done')
    effectStore.markStarted('run-2', 'other-run')

    expect(effectStore.clearStartedEffects('run-1')).toBe(1)
    expect(effectStore.getEffect('run-1', 'started')).toBeNull()
    expect(effectStore.getEffect('run-1', 'will-complete')?.state).toBe('completed')
    expect(effectStore.getEffect('run-2', 'other-run')?.state).toBe('started')
  })

  it('effects scoped per run', () => {
    effectStore.markStarted('run-1', 'key')
    effectStore.markStarted('run-2', 'key')
    effectStore.markCompleted('run-1', 'key', 'done')
    expect(effectStore.getEffect('run-1', 'key')!.state).toBe('completed')
    expect(effectStore.getEffect('run-2', 'key')!.state).toBe('started')
  })

  it('markStarted overwrites started record (crash re-execute)', () => {
    effectStore.markStarted('run-1', 'key')
    effectStore.markStarted('run-1', 'key')
    expect(effectStore.getEffect('run-1', 'key')!.state).toBe('started')
  })

  it('completed effect survives close + reopen (persistence)', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const path = require('node:path')
    const tmpFile = path.join(os.tmpdir(), `effect-test-${Date.now()}.db`)
    try {
      const s1 = createSqliteStores(tmpFile)
      s1.effectStore.markStarted('run-1', 'charge')
      s1.effectStore.markCompleted('run-1', 'charge', { id: 42 })
      s1.close()

      const s2 = createSqliteStores(tmpFile)
      const record = s2.effectStore.getEffect('run-1', 'charge')!
      expect(record.state).toBe('completed')
      expect(record.output).toEqual({ id: 42 })
      s2.close()
    } finally {
      try {
        fs.unlinkSync(tmpFile)
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-wal')
      } catch {}
      try {
        fs.unlinkSync(tmpFile + '-shm')
      } catch {}
    }
  })
})
