import type { Run } from '../types.js'

export type TraceNode = {
  id: string
  processName: string
  eventName: string
  state: string
  depth: number
  idleAt: number | null
  runningAt: number | null
  completedAt: number | null
  children: TraceNode[]
}

export function buildTraceTree(runs: Run[]): TraceNode[] {
  const nodeMap = new Map<string, TraceNode>()

  for (const run of runs) {
    const timeline = run.timeline || []
    const idleEntry = timeline.find((t) => t.state === 'idle')
    const runningEntry = timeline.find((t) => t.state === 'running')
    const terminalEntry = timeline.find((t) => t.state === 'completed' || t.state === 'errored')

    nodeMap.set(run.id, {
      id: run.id,
      processName: run.processName,
      eventName: run.eventName,
      state: run.state,
      depth: run.depth ?? 0,
      idleAt: idleEntry?.timestamp ?? run.startedAt ?? null,
      runningAt: runningEntry?.timestamp ?? null,
      completedAt: terminalEntry?.timestamp ?? run.completedAt ?? null,
      children: [],
    })
  }

  const roots: TraceNode[] = []
  for (const run of runs) {
    const node = nodeMap.get(run.id)!
    if (run.parentRunId && nodeMap.has(run.parentRunId)) {
      nodeMap.get(run.parentRunId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

export function flattenTrace(nodes: TraceNode[], result: Omit<TraceNode, 'children'>[] = [], indent: number = 0): Omit<TraceNode, 'children'>[] {
  for (const node of nodes) {
    const { children, ...flat } = node
    flat.depth = indent
    result.push(flat)
    flattenTrace(children, result, indent + 1)
  }
  return result
}
