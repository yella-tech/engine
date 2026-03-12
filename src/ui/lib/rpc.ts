import { hc } from 'hono/client'
import type { EngineApi } from '../../server/routes.js'

const client = hc<EngineApi>('/')

async function unwrapJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim()
    try {
      const body = await response.json() as { error?: string; message?: string }
      message = body.error || body.message || message
    } catch {
      /* keep default status text */
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

function stringQuery(values: Record<string, string | number | boolean | undefined>) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    query[key] = String(value)
  }
  return query
}

export const rpc = {
  health: {
    get: async () => unwrapJson(await client.health.$get()),
  },
  overview: {
    get: async (query: { limit?: number; root?: boolean; observabilityWindow?: string }) =>
      unwrapJson(await client.overview.$get({ query: stringQuery(query) })),
  },
  observability: {
    get: async (query: { from?: number; to?: number; window?: string; bucketMs?: number }) =>
      unwrapJson(await client.observability.$get({ query: stringQuery(query) })),
  },
  runs: {
    list: async (query: { limit?: number; offset?: number; state?: string; status?: string; root?: boolean }) =>
      unwrapJson(await client.runs.$get({ query: stringQuery(query) })),
    get: async (id: string) => unwrapJson(await client.runs[':id'].$get({ param: { id } })),
    chain: async (id: string) => unwrapJson(await client.runs[':id'].chain.$get({ param: { id } })),
    overlay: async (id: string, query?: { selectedId?: string }) =>
      unwrapJson(await client.runs[':id'].overlay.$get({ param: { id }, query: stringQuery(query ?? {}) })),
    trace: async (id: string) => unwrapJson(await client.runs[':id'].trace.$get({ param: { id } })),
    effects: async (id: string) => unwrapJson(await client.runs[':id'].effects.$get({ param: { id } })),
    retry: async (id: string) => unwrapJson(await client.runs[':id'].retry.$post({ param: { id } })),
    requeue: async (id: string) => unwrapJson(await client.runs[':id'].requeue.$post({ param: { id } })),
    resume: async (id: string, payload?: unknown) =>
      unwrapJson(await client.runs[':id'].resume.$post({ param: { id }, json: payload === undefined ? {} : payload })),
  },
  graph: {
    get: async () => unwrapJson(await client.graph.$get()),
  },
  emit: {
    post: async (json: { event: string; payload: unknown; idempotencyKey?: string }) =>
      unwrapJson(await client.emit.$post({ json })),
  },
}

export type EngineRpcClient = typeof rpc
