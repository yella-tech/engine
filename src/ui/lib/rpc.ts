import type { createEngineRouteServices } from '../../server/engine-services.js'

type EngineRouteServices = ReturnType<typeof createEngineRouteServices>

type HealthResponse = ReturnType<EngineRouteServices['reads']['health']>
type OverviewResponse = ReturnType<EngineRouteServices['reads']['overview']>
type ObservabilityResponse = ReturnType<EngineRouteServices['reads']['observability']>
type RunsListResponse = ReturnType<EngineRouteServices['reads']['runs']>
type RunResponse = NonNullable<ReturnType<EngineRouteServices['reads']['run']>>
type RunChainResponse = NonNullable<ReturnType<EngineRouteServices['reads']['chain']>>
type RunOverlayResponse = NonNullable<ReturnType<EngineRouteServices['reads']['overlay']>>
type RunTraceResponse = NonNullable<ReturnType<EngineRouteServices['reads']['trace']>>
type RunEffectsResponse = NonNullable<ReturnType<EngineRouteServices['reads']['effects']>>
type GraphResponse = ReturnType<EngineRouteServices['reads']['graph']>
type RetryResponse = ReturnType<EngineRouteServices['commands']['retry']>
type RequeueResponse = ReturnType<EngineRouteServices['commands']['requeue']>
type ResumeResponse = ReturnType<EngineRouteServices['commands']['resume']>
type EmitResponse = ReturnType<EngineRouteServices['commands']['emit']>

async function unwrapJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      message = body.error || body.message || message
    } catch {
      /* keep default status text */
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

function stringQuery(values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    query.set(key, String(value))
  }
  const search = query.toString()
  return search ? `?${search}` : ''
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return unwrapJson<T>(await fetch(path, init))
}

export const rpc = {
  health: {
    get: async (): Promise<HealthResponse> => requestJson('/health'),
  },
  overview: {
    get: async (query: { limit?: number; root?: boolean; observabilityWindow?: string }): Promise<OverviewResponse> => requestJson(`/overview${stringQuery(query)}`),
  },
  observability: {
    get: async (query: { from?: number; to?: number; window?: string; bucketMs?: number }): Promise<ObservabilityResponse> => requestJson(`/observability${stringQuery(query)}`),
  },
  runs: {
    list: async (query: { limit?: number; offset?: number; state?: string; status?: string; root?: boolean }): Promise<RunsListResponse> => requestJson(`/runs${stringQuery(query)}`),
    get: async (id: string): Promise<RunResponse> => requestJson(`/runs/${id}`),
    chain: async (id: string): Promise<RunChainResponse> => requestJson(`/runs/${id}/chain`),
    overlay: async (id: string, query?: { selectedId?: string }): Promise<RunOverlayResponse> => requestJson(`/runs/${id}/overlay${stringQuery(query ?? {})}`),
    trace: async (id: string): Promise<RunTraceResponse> => requestJson(`/runs/${id}/trace`),
    effects: async (id: string): Promise<RunEffectsResponse> => requestJson(`/runs/${id}/effects`),
    retry: async (id: string): Promise<RetryResponse> => requestJson(`/runs/${id}/retry`, { method: 'POST' }),
    requeue: async (id: string): Promise<RequeueResponse> => requestJson(`/runs/${id}/requeue`, { method: 'POST' }),
    resume: async (id: string, payload?: unknown): Promise<ResumeResponse> =>
      requestJson(`/runs/${id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      }),
  },
  graph: {
    get: async (): Promise<GraphResponse> => requestJson('/graph'),
  },
  emit: {
    post: async (json: { event: string; payload: unknown; idempotencyKey?: string }): Promise<EmitResponse> =>
      requestJson('/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      }),
  },
}

export type EngineRpcClient = typeof rpc
