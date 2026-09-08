import { describe, it, expect, afterEach } from 'vitest'
import { createEngine, createEffectStore, ErrorCode } from './index.js'
import { getRunStatus } from './status.js'
import type { EngineEvent, Run } from './types.js'

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('chain depth exceeded is reported like any other failure', () => {
  let engine: ReturnType<typeof createEngine>
  afterEach(async () => {
    await engine?.stop()
  })

  it('emits run:error and calls onRunError/onRunFinish for the run that overflowed', async () => {
    const errors: { run: Run; error: string }[] = []
    const finished: string[] = []
    const events: EngineEvent[] = []
    engine = createEngine({
      store: { type: 'memory' },
      maxChainDepth: 1,
      onRunError: (run, error) => errors.push({ run, error }),
      onRunFinish: (run) => finished.push(run.processName),
      onEvent: (e) => events.push(e),
    })
    engine.process({ name: 'p1', on: 'a', emits: ['b'], run: async (ctx) => ctx.ok({}, { emit: 'b' }) })
    engine.process({ name: 'p2', on: 'b', emits: ['c'], run: async (ctx) => ctx.ok({}, { emit: 'c' }) })
    engine.process({ name: 'p3', on: 'c', run: async (ctx) => ctx.ok({}) })

    engine.emit('a', {})
    await engine.drain(2000)

    const errored = engine.getErrored()
    expect(errored).toHaveLength(1)
    expect(errored[0].processName).toBe('p2')
    expect(errored[0].result?.errorCode).toBe(ErrorCode.CHAIN_DEPTH_EXCEEDED)

    expect(errors.map((e) => e.run.processName)).toEqual(['p2'])
    expect(finished).toContain('p2')
    expect(events.filter((e) => e.type === 'run:error').map((e: any) => e.run.processName)).toEqual(['p2'])
  })
})

describe('a fenced in-progress effect is not retried', () => {
  let engine: ReturnType<typeof createEngine>
  afterEach(async () => {
    await engine?.stop()
  })

  it('dead-letters on the first retry instead of burning the retry budget', async () => {
    const retries: number[] = []
    engine = createEngine({
      store: { type: 'memory' },
      retry: { maxRetries: 3, delay: 0 },
      handlerTimeoutMs: 30,
      onRetry: (_run, _err, attempt) => retries.push(attempt),
    })
    engine.register('proc', 'go', async (ctx) => {
      await ctx.effect('slow', () => new Promise((r) => setTimeout(r, 300)))
      return { success: true }
    })
    engine.emit('go', {})
    await engine.drain(3000)

    const errored = engine.getErrored()
    expect(errored).toHaveLength(1)
    expect(getRunStatus(errored[0])).toBe('dead-letter')
    expect(errored[0].result?.error).toMatch(/already in progress/)
    expect(errored[0].attempt).toBe(1)
    expect(retries).toEqual([0])
  })
})

describe('retention prunes exactly what was offered to beforePrune', () => {
  let engine: ReturnType<typeof createEngine>
  afterEach(async () => {
    await engine?.stop()
  })

  it('does not prune a run that only became eligible during the archive callback', async () => {
    let c2Succeeds = false
    let pruneCalls = 0
    const offered: string[][] = []
    engine = createEngine({
      store: 'memory',
      retention: 200,
      beforePrune: async (chains) => {
        pruneCalls++
        offered.push(chains.flatMap((c) => c.runs.map((r) => r.processName)))
        if (pruneCalls === 1) {
          c2Succeeds = true
          const c2 = engine.getErrored().find((r) => r.processName === 'C2')!
          engine.retryRun(c2.id)
          await waitFor(() => engine.getCompleted().some((r) => r.processName === 'C2'))
        }
      },
    })
    engine.register('other', 'other', async () => ({ success: true }))
    engine.register('P', 'go', async () => ({ success: true, triggerEvent: 'x' }))
    engine.register('C1', 'x', async () => ({ success: true }))
    engine.register('C2', 'x', async () => {
      if (!c2Succeeds) throw new Error('boom')
      return { success: true }
    })

    engine.emit('other', {})
    engine.emit('go', {})
    await engine.drain(2000)
    expect(engine.getErrored().map((r) => r.processName)).toEqual(['C2'])

    await waitFor(() => pruneCalls >= 1, 3000)
    await new Promise((r) => setTimeout(r, 60))

    expect(offered[0]).toEqual(['other'])
    const c1 = engine.getCompleted().find((r) => r.processName === 'C1')!
    expect(c1.archived).toBeFalsy()
  })
})

describe('memory effect store isolates stored output from caller mutation', () => {
  it('returns the output as it was stored, not as later mutated', () => {
    const store = createEffectStore()
    const out = { n: 1 }
    store.markStarted('r', 'k')
    store.markCompleted('r', 'k', out)
    out.n = 999
    expect(store.getEffect('r', 'k')!.output).toEqual({ n: 1 })
    const read = store.getEffect('r', 'k')!.output as { n: number }
    read.n = 42
    expect(store.getEffect('r', 'k')!.output).toEqual({ n: 1 })
  })
})

describe('graceful stop', () => {
  it('leaves no extra Timeout handle behind after a clean graceful stop', async () => {
    const engine = createEngine({ store: { type: 'memory' } })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', {})
    await engine.drain(2000)

    const count = () => (process as any).getActiveResourcesInfo().filter((r: string) => r === 'Timeout').length
    const before = count()
    await engine.stop({ graceful: true, timeoutMs: 60_000 })
    expect(count()).toBeLessThanOrEqual(before)
  })

  it('on timeout, aborts the stragglers, tears down, and then rethrows', async () => {
    const engine = createEngine({ store: 'memory' })
    engine.register('hang', 'go', async () => new Promise(() => {}))
    engine.emit('go', {})
    await waitFor(() => engine.getRunning().length === 1)

    await expect(engine.stop({ graceful: true, timeoutMs: 50 })).rejects.toMatchObject({ code: ErrorCode.GRACEFUL_STOP_TIMEOUT })
    expect(engine.getRunning()).toHaveLength(0)
    await expect(engine.stop()).resolves.toBeUndefined()
  })
})
