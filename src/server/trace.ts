import { getRunStatus } from '../status.js'
import type { ProcessState, Run, RunStatus } from '../types.js'

const DEFERRED_GAP_THRESHOLD_MS = 50

export type TraceNode = {
  id: string
  processName: string
  eventName: string
  state: ProcessState
  status: RunStatus
  depth: number
  idleAt: number | null
  runningAt: number | null
  completedAt: number | null
  children: TraceNode[]
}

export type TraceGap = {
  type: 'deferred'
  parentRunId: string
  childRunIds: string[]
  start: number
  end: number
  durationMs: number
}

function getRunTimes(run: Run) {
  const timeline = run.timeline || []
  const idleEntry = timeline.find((t) => t.state === 'idle')
  const runningEntry = timeline.find((t) => t.state === 'running')
  const terminalEntry = timeline.find((t) => t.state === 'completed' || t.state === 'errored')

  return {
    idleAt: idleEntry?.timestamp ?? run.startedAt ?? null,
    runningAt: runningEntry?.timestamp ?? null,
    completedAt: terminalEntry?.timestamp ?? run.completedAt ?? null,
  }
}

export function buildTraceTree(runs: Run[]): TraceNode[] {
  const nodeMap = new Map<string, TraceNode>()

  for (const run of runs) {
    const { idleAt, runningAt, completedAt } = getRunTimes(run)

    nodeMap.set(run.id, {
      id: run.id,
      processName: run.processName,
      eventName: run.eventName,
      state: run.state,
      status: getRunStatus(run),
      depth: run.depth ?? 0,
      idleAt,
      runningAt,
      completedAt,
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

export function buildTraceGaps(runs: Run[]): TraceGap[] {
  const childrenByParent = new Map<string, Run[]>()
  for (const run of runs) {
    if (!run.parentRunId) continue
    const children = childrenByParent.get(run.parentRunId) ?? []
    children.push(run)
    childrenByParent.set(run.parentRunId, children)
  }

  const gaps: TraceGap[] = []
  for (const run of runs) {
    if (typeof run.result?.triggerEvent !== 'string') continue

    const children = childrenByParent.get(run.id) ?? []
    if (!children.length) continue

    const { completedAt } = getRunTimes(run)
    if (completedAt === null) continue

    const childStarts = children.map((child) => ({ id: child.id, idleAt: getRunTimes(child).idleAt })).filter((child): child is { id: string; idleAt: number } => child.idleAt !== null)
    if (!childStarts.length) continue

    const earliestChildStart = Math.min(...childStarts.map((child) => child.idleAt))
    const gapDuration = earliestChildStart - completedAt
    if (gapDuration < DEFERRED_GAP_THRESHOLD_MS) continue

    gaps.push({
      type: 'deferred',
      parentRunId: run.id,
      childRunIds: childStarts.map((child) => child.id),
      start: completedAt,
      end: earliestChildStart,
      durationMs: gapDuration,
    })
  }

  return gaps.sort((a, b) => a.start - b.start)
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
