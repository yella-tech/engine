import { useMemo } from 'preact/hooks'
import { ChainPicker } from './ChainPicker'
import { navigate } from '../hooks/useHashRoute'
import { useChainRunsQuery, useGraphQuery, useRootRunsQuery } from '../runtime/dashboard-queries'

const NODE_W = 180
const NODE_H = 56
const LAYER_GAP_Y = 80
const NODE_GAP_X = 32
const PAD = 40

interface GraphNode {
  name: string
  on: string
  emits?: string[]
}

interface GraphEdge {
  from: string
  event: string
  to: string
}

interface ExecutedNode {
  processName: string
  runId: string
  state: string
  status: string
}

interface Pos {
  x: number
  y: number
}

function layoutTree(nodes: GraphNode[], edges: GraphEdge[]) {
  const adj = new Map<string, string[]>()
  const inbound = new Map<string, number>()
  for (const n of nodes) {
    adj.set(n.name, [])
    inbound.set(n.name, 0)
  }
  for (const e of edges) {
    if (adj.has(e.from) && inbound.has(e.to)) {
      adj.get(e.from)!.push(e.to)
      inbound.set(e.to, (inbound.get(e.to) || 0) + 1)
    }
  }

  // BFS from roots
  const layers = new Map<string, number>()
  const queue: string[] = []
  for (const n of nodes) {
    if ((inbound.get(n.name) || 0) === 0) {
      layers.set(n.name, 0)
      queue.push(n.name)
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!
    const curLayer = layers.get(cur)!
    for (const next of adj.get(cur) || []) {
      const prev = layers.get(next)
      const newLayer = curLayer + 1
      if (prev === undefined || newLayer > prev) {
        layers.set(next, newLayer)
        queue.push(next)
      }
    }
  }
  // Orphans
  for (const n of nodes) {
    if (!layers.has(n.name)) layers.set(n.name, 0)
  }

  // Group by layer
  const byLayer = new Map<number, string[]>()
  for (const n of nodes) {
    const l = layers.get(n.name)!
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n.name)
  }

  const maxLayer = Math.max(0, ...byLayer.keys())
  const positions = new Map<string, Pos>()

  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) || []
    const totalW = col.length * NODE_W + (col.length - 1) * NODE_GAP_X
    const startX = PAD + (col.length > 1 ? 0 : 0)
    col.forEach((name, i) => {
      positions.set(name, {
        x: startX + i * (NODE_W + NODE_GAP_X),
        y: PAD + l * (NODE_H + LAYER_GAP_Y),
      })
    })
  }

  // Center layers relative to widest
  let maxWidth = 0
  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) || []
    const w = col.length * NODE_W + (col.length - 1) * NODE_GAP_X
    if (w > maxWidth) maxWidth = w
  }
  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) || []
    const w = col.length * NODE_W + (col.length - 1) * NODE_GAP_X
    const offset = (maxWidth - w) / 2
    for (const name of col) {
      const p = positions.get(name)!
      positions.set(name, { x: p.x + offset, y: p.y })
    }
  }

  const allPos = [...positions.values()]
  const svgW = allPos.length ? Math.max(...allPos.map((p) => p.x + NODE_W)) + PAD : 400
  const svgH = allPos.length ? Math.max(...allPos.map((p) => p.y + NODE_H)) + PAD : 200

  return { positions, svgW, svgH }
}

function edgePath(from: Pos, to: Pos) {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const dy = (y2 - y1) * 0.5
  return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`
}

function fmtDuration(ms?: number) {
  if (ms == null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function graphStatusLabel(status: string) {
  return status === 'dead-letter' ? 'DLQ' : status.toUpperCase()
}

function graphStatusTone(status: string) {
  switch (status) {
    case 'running':
      return { fill: 'var(--black)', text: 'var(--white)', stroke: 'var(--accent)', strokeWidth: 3, dash: undefined, rail: 'var(--accent)' }
    case 'deferred':
      return { fill: 'var(--white)', text: 'var(--black)', stroke: 'var(--accent-dim)', strokeWidth: 3, dash: '10 4', rail: 'var(--accent)' }
    case 'dead-letter':
      return { fill: 'var(--black)', text: 'var(--accent)', stroke: 'var(--accent)', strokeWidth: 3, dash: undefined, rail: 'var(--accent)' }
    case 'errored':
      return { fill: 'var(--white)', text: 'var(--black)', stroke: 'var(--black)', strokeWidth: 3, dash: '5 3', rail: 'var(--black)' }
    case 'idle':
      return { fill: 'var(--surface)', text: 'var(--black)', stroke: 'var(--muted)', strokeWidth: 2, dash: '6 3', rail: 'var(--muted)' }
    default:
      return { fill: 'var(--accent)', text: 'var(--black)', stroke: 'var(--black)', strokeWidth: 2.5, dash: undefined, rail: 'var(--black)' }
  }
}

export interface GraphPanelProps {
  chainId?: string
  onNodeClick?: (runId: string) => void
}

export function GraphPanel({ chainId, onNodeClick }: GraphPanelProps) {
  const graphQuery = useGraphQuery()
  const chainOptionsQuery = useRootRunsQuery(100)
  const chainRunsQuery = useChainRunsQuery(chainId)
  const graphData = graphQuery.data ?? null
  const chainRuns = useMemo(
    () => (chainRunsQuery.data?.runs || []).sort((a: any, b: any) => (a.depth ?? 0) - (b.depth ?? 0) || a.startedAt - b.startedAt),
    [chainRunsQuery.data],
  )
  const chainOptions = useMemo(
    () =>
      (chainOptionsQuery.data?.runs || [])
        .filter((r: any) => r.childRunIds && r.childRunIds.length > 0)
        .map((r: any) => {
          const when = new Date(r.startedAt).toLocaleTimeString()
          return { id: r.id, label: `${r.processName} / ${r.eventName} \u25B8 chain \u2014 ${when}` }
        }),
    [chainOptionsQuery.data],
  )
  const loading = (graphQuery.isFetching && !graphQuery.data) || (chainOptionsQuery.isFetching && !chainOptionsQuery.data) || (!!chainId && chainRunsQuery.isFetching && !chainRunsQuery.data)

  if (loading) return <div class="empty">Loading graph...</div>

  const nodes: GraphNode[] = graphData ? graphData.nodes || [] : []
  const edges: GraphEdge[] = graphData ? graphData.edges || [] : []

  const executedMap = new Map<string, ExecutedNode>()
  const executedEdges = new Set<string>()

  // When viewing a chain, filter to only relevant processes:
  // - Executed processes
  // - Declared emits targets of executed processes (paths not taken)
  let mergedNodes: GraphNode[]
  let mergedEdges: GraphEdge[]

  if (chainRuns.length > 0) {
    const byId = new Map<string, any>()
    for (const r of chainRuns) {
      byId.set(r.id, r)
      executedMap.set(r.processName, {
        processName: r.processName,
        runId: r.id,
        state: r.state,
        status: r.status || r.state,
      })
    }
    // Build executed edges
    for (const r of chainRuns) {
      if (r.parentRunId) {
        const parent = byId.get(r.parentRunId)
        if (parent) {
          executedEdges.add(`${parent.processName}:${r.eventName}:${r.processName}`)
        }
      }
    }

    // Build the relevant node set: executed + declared emits targets
    const relevantNames = new Set(chainRuns.map((r: any) => r.processName))
    // For each executed process, find its declared emits targets in the static graph
    for (const e of edges) {
      if (relevantNames.has(e.from)) {
        relevantNames.add(e.to)
      }
    }

    // Filter to relevant nodes only
    const nodeByName = new Map(nodes.map((n) => [n.name, n]))
    mergedNodes = []
    const addedNames = new Set<string>()
    for (const name of relevantNames) {
      if (addedNames.has(name)) continue
      addedNames.add(name)
      const existing = nodeByName.get(name)
      if (existing) {
        mergedNodes.push(existing)
      } else {
        // Runtime-only node (not in static graph)
        const run = chainRuns.find((r: any) => r.processName === name)
        mergedNodes.push({ name, on: run?.eventName || '', emits: [] })
      }
    }

    // Filter edges to only those between relevant nodes
    mergedEdges = edges.filter((e) => relevantNames.has(e.from) && relevantNames.has(e.to))
    // Add runtime-only edges
    const existingEdgeKeys = new Set(mergedEdges.map((e) => `${e.from}:${e.event}:${e.to}`))
    for (const r of chainRuns) {
      if (r.parentRunId) {
        const parent = byId.get(r.parentRunId)
        if (parent) {
          const key = `${parent.processName}:${r.eventName}:${r.processName}`
          if (!existingEdgeKeys.has(key)) {
            mergedEdges.push({ from: parent.processName, event: r.eventName, to: r.processName })
            existingEdgeKeys.add(key)
          }
        }
      }
    }
  } else {
    mergedNodes = [...nodes]
    mergedEdges = [...edges]
  }

  const hasStaticGraph = chainRuns.length === 0 && mergedEdges.length > 0
  const showGraph = mergedNodes.length > 0 && (chainRuns.length > 0 || hasStaticGraph)

  const picker = (
    <ChainPicker
      label="Select a completed chain to graph"
      placeholder="Filter by process, event, or time"
      emptyLabel="No chains match that filter"
      options={chainOptions}
      selectedId={chainId || ''}
      onChange={(id) => navigate(id ? `/graph/${id}` : '/graph')}
    />
  )

  if (!showGraph) {
    return (
      <div>
        {picker}
        {chainRuns.length === 0 && mergedNodes.length > 0 && (
          <div class="graph-empty">
            {mergedNodes.length} processes registered but no relationships declared. Add <code>emits</code> to your process registrations to see the dependency graph, or select a chain above.
          </div>
        )}
        {mergedNodes.length === 0 && (
          <div class="graph-empty">No processes registered.</div>
        )}
      </div>
    )
  }

  const { positions, svgW, svgH } = layoutTree(mergedNodes, mergedEdges)

  return (
    <div>
      {picker}
      <div class="graph-container">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${svgW} ${svgH}`} style={`width:${svgW}px;max-width:100%;height:auto;display:block`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
              <polygon points="0 0, 10 3.5, 0 7" fill="#999" />
            </marker>
            <marker id="arrow-active" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
              <polygon points="0 0, 10 3.5, 0 7" fill="#000" />
            </marker>
          </defs>
          {/* Render edges, ghost first, then executed on top */}
          {mergedEdges.map((e, i) => {
            const from = positions.get(e.from)
            const to = positions.get(e.to)
            if (!from || !to) return null
            const eKey = `${e.from}:${e.event}:${e.to}`
            const isExecuted = executedEdges.has(eKey)
            const d = edgePath(from, to)
            const mx = (from.x + NODE_W / 2 + to.x + NODE_W / 2) / 2
            const my = (from.y + NODE_H + to.y) / 2
            return (
              <g key={'e' + i}>
                <path
                  d={d}
                  fill="none"
                  stroke={isExecuted ? '#000' : '#bbb'}
                  stroke-width={isExecuted ? 2.5 : 1.5}
                  stroke-dasharray={isExecuted ? undefined : '6 3'}
                  marker-end={isExecuted ? 'url(#arrow-active)' : 'url(#arrow)'}
                />
                <text x={mx} y={my - 6} text-anchor="middle" font-size="10" fill={isExecuted ? '#000' : '#999'} font-family="var(--font)">
                  {e.event}
                </text>
              </g>
            )
          })}
          {/* Render nodes */}
          {mergedNodes.map((n) => {
            const pos = positions.get(n.name)
            if (!pos) return null
            const exec = executedMap.get(n.name)
            const isExecuted = !!exec
            const clickable = isExecuted && onNodeClick
            const tone = exec ? graphStatusTone(exec.status) : null
            return (
              <g key={n.name} style={clickable ? 'cursor:pointer' : undefined} onClick={() => clickable && onNodeClick!(exec!.runId)}>
                {tone && <rect x={pos.x} y={pos.y} width="8" height={NODE_H} fill={tone.rail} />}
                <rect
                  x={pos.x}
                  y={pos.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx="0"
                  fill={tone ? tone.fill : 'var(--white)'}
                  stroke={tone ? tone.stroke : '#ccc'}
                  stroke-width={tone ? tone.strokeWidth : 1.5}
                  stroke-dasharray={tone ? tone.dash : '6 3'}
                />
                <text x={pos.x + NODE_W / 2 + (tone ? 4 : 0)} y={pos.y + 22} text-anchor="middle" font-size="12" font-weight="700" fill={tone ? tone.text : 'var(--black)'} font-family="var(--font)">
                  {n.name.toUpperCase()}
                </text>
                {isExecuted ? (
                  <text x={pos.x + NODE_W / 2 + (tone ? 4 : 0)} y={pos.y + 40} text-anchor="middle" font-size="9" fill={tone ? tone.text : 'var(--black)'} font-family="var(--font)">
                    {graphStatusLabel(exec!.status)}
                  </text>
                ) : (
                  <text x={pos.x + NODE_W / 2} y={pos.y + 40} text-anchor="middle" font-size="9" fill="#999" font-family="var(--font)">
                    on: {n.on}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div class="graph-legend">
        <span>
          <span class="graph-swatch graph-swatch-active"></span> executed
        </span>
        <span>
          <span class="graph-swatch graph-swatch-static"></span> declared
        </span>
        <span>
          <span class="graph-swatch graph-swatch-deferred"></span> deferred
        </span>
        <span>
          <span class="graph-swatch graph-swatch-dlq"></span> dlq
        </span>
      </div>
    </div>
  )
}
