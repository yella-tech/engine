import type { Run, ProcessState, ProcessDefinition, EffectRecord, EngineMetrics, EngineObservabilityQuery, EngineObservabilityReport, EventGraph, RunStatus, EngineEvent } from '../types.js'

/** Minimal engine surface required by the HTTP server layer. */
export interface RoutableEngine {
  getRunning(): Run[]
  getIdle(): Run[]
  getCompleted(): Run[]
  getErrored(): Run[]
  getProcesses(): ProcessDefinition[]
  getRun(id: string): Run | null
  getChain(runId: string): Run[]
  getEffects(runId: string): EffectRecord[]
  retryRun(runId: string): Run
  requeueDead(runId: string): Run
  getGraph(): EventGraph
  emit(event: string, payload: unknown, opts?: { idempotencyKey?: string }): Run[]
  resume(runId: string, payload?: unknown): Run[]
  countByState(state: ProcessState): number
  getRunsByStatusPaginated(status: RunStatus, limit: number, offset: number, opts?: { root?: boolean; order?: 'asc' | 'desc' }): { runs: Run[]; total: number }
  getRunsPaginated(state: ProcessState | null, limit: number, offset: number, opts?: { root?: boolean; order?: 'asc' | 'desc' }): { runs: Run[]; total: number }
  getMetrics(): EngineMetrics
  getObservability(query?: EngineObservabilityQuery): EngineObservabilityReport
  subscribeEvents(listener: (event: EngineEvent) => void): () => void
}
