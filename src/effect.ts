import type { EffectRecord, EffectStore } from './types.js'

export function createEffectStore(): EffectStore {
  const effects = new Map<string, Map<string, EffectRecord>>()

  function getEffect(runId: string, effectKey: string): EffectRecord | null {
    return effects.get(runId)?.get(effectKey) ?? null
  }

  function markStarted(runId: string, effectKey: string): void {
    if (!effects.has(runId)) effects.set(runId, new Map())
    effects.get(runId)!.set(effectKey, {
      runId,
      effectKey,
      state: 'started',
      output: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
    })
  }

  function markCompleted(runId: string, effectKey: string, output: unknown): void {
    const record = effects.get(runId)?.get(effectKey)
    if (!record) return
    record.state = 'completed'
    record.output = output
    record.completedAt = Date.now()
  }

  function markFailed(runId: string, effectKey: string, error: string): void {
    const record = effects.get(runId)?.get(effectKey)
    if (!record) return
    record.state = 'failed'
    record.error = error
    record.completedAt = Date.now()
  }

  function getEffects(runId: string): EffectRecord[] {
    const inner = effects.get(runId)
    return inner ? Array.from(inner.values()) : []
  }

  function deleteEffectsForRuns(runIds: string[]): number {
    let deleted = 0
    for (const runId of runIds) {
      const inner = effects.get(runId)
      if (!inner) continue
      deleted += inner.size
      effects.delete(runId)
    }
    return deleted
  }

  return { getEffect, getEffects, markStarted, markCompleted, markFailed, deleteEffectsForRuns }
}
