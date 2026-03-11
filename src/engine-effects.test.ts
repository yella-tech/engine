import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'
import type { EngineOptions } from './types.js'

function effectTests(storeType: string, engineOpts: EngineOptions) {
  describe(`ctx.effect() (${storeType})`, () => {
    let engine: ReturnType<typeof createEngine>

    afterEach(async () => {
      await engine?.stop()
    })

    it('effect executes fn and returns result', async () => {
      engine = createEngine(engineOpts)
      engine.register('proc', 'evt', async (ctx) => {
        const result = await ctx.effect('my-effect', () => 42)
        return { success: true, payload: result }
      })
      const [run] = await engine.emitAndWait('evt', null)
      expect(engine.getRun(run.id)!.result!.payload).toBe(42)
    })

    it('completed effect replays stored output on retry (no re-execution)', async () => {
      let effectCallCount = 0
      let handlerCallCount = 0
      engine = createEngine(engineOpts)
      engine.register(
        'proc',
        'evt',
        async (ctx) => {
          handlerCallCount++
          const val = await ctx.effect('charge', () => {
            effectCallCount++
            return { chargeId: 'ch_123' }
          })
          // First handler invocation: effect succeeds, then we crash
          if (handlerCallCount === 1) throw new Error('simulated crash')
          return { success: true, payload: val }
        },
        { retry: { maxRetries: 1, delay: 0 } },
      )
      const [run] = await engine.emitAndWait('evt', null)
      const finished = engine.getRun(run.id)!
      expect(finished.state).toBe('completed')
      expect(finished.result!.payload).toEqual({ chargeId: 'ch_123' })
      // Effect fn was only called once, replay returned stored output on retry
      expect(effectCallCount).toBe(1)
      // Handler was called twice (initial + retry)
      expect(handlerCallCount).toBe(2)
    })

    it('failed effect re-executes on retry', async () => {
      let callCount = 0
      engine = createEngine(engineOpts)
      engine.register(
        'proc',
        'evt',
        async (ctx) => {
          const val = await ctx.effect('webhook', () => {
            callCount++
            if (callCount === 1) throw new Error('connection refused')
            return 'delivered'
          })
          return { success: true, payload: val }
        },
        { retry: { maxRetries: 1, delay: 0 } },
      )
      const [run] = await engine.emitAndWait('evt', null)
      const finished = engine.getRun(run.id)!
      expect(finished.state).toBe('completed')
      expect(finished.result!.payload).toBe('delivered')
      expect(callCount).toBe(2) // failed on first, re-executed on retry
    })

    it('multiple effects in same handler tracked independently', async () => {
      engine = createEngine(engineOpts)
      engine.register('proc', 'evt', async (ctx) => {
        const a = await ctx.effect('effect-a', () => 'alpha')
        const b = await ctx.effect('effect-b', () => 'beta')
        return { success: true, payload: { a, b } }
      })
      const [run] = await engine.emitAndWait('evt', null)
      expect(engine.getRun(run.id)!.result!.payload).toEqual({ a: 'alpha', b: 'beta' })
    })

    it('effect with async fn', async () => {
      engine = createEngine(engineOpts)
      engine.register('proc', 'evt', async (ctx) => {
        const val = await ctx.effect('async-op', async () => {
          await new Promise((r) => setTimeout(r, 10))
          return 'async-result'
        })
        return { success: true, payload: val }
      })
      const [run] = await engine.emitAndWait('evt', null)
      expect(engine.getRun(run.id)!.result!.payload).toBe('async-result')
    })

    it('effect output serialized/deserialized correctly (objects, arrays, primitives)', async () => {
      let effectCallCount = 0
      let handlerCallCount = 0
      engine = createEngine(engineOpts)
      engine.register(
        'proc',
        'evt',
        async (ctx) => {
          handlerCallCount++
          const obj = await ctx.effect('obj', () => {
            effectCallCount++
            return { nested: { deep: true }, arr: [1, 2, 3] }
          })
          const str = await ctx.effect('str', () => {
            effectCallCount++
            return 'hello'
          })
          const num = await ctx.effect('num', () => {
            effectCallCount++
            return 99
          })
          const nul = await ctx.effect('null', () => {
            effectCallCount++
            return null
          })
          if (handlerCallCount === 1) throw new Error('force retry')
          return { success: true, payload: { obj, str, num, nul } }
        },
        { retry: { maxRetries: 1, delay: 0 } },
      )
      const [run] = await engine.emitAndWait('evt', null)
      const finished = engine.getRun(run.id)!
      expect(finished.state).toBe('completed')
      expect(finished.result!.payload).toEqual({
        obj: { nested: { deep: true }, arr: [1, 2, 3] },
        str: 'hello',
        num: 99,
        nul: null,
      })
      // Effects only called once, replayed on retry
      expect(effectCallCount).toBe(4)
      // Handler was called twice (initial + retry)
      expect(handlerCallCount).toBe(2)
    })

    it('retention prunes completed runs and effect records but keeps deferred runs', async () => {
      engine = createEngine({ ...engineOpts, retention: '25ms' })
      engine.register('effected', 'evt', async (ctx) => {
        await ctx.effect('persisted', () => ({ ok: true }))
        return { success: true }
      })
      engine.register('review', 'hold', async () => ({ success: true, triggerEvent: 'next', deferred: true }))

      const [completed] = await engine.emitAndWait('evt', null)
      const [deferred] = await engine.emitAndWait('hold', null)
      expect(engine.getEffects(completed.id)).toHaveLength(1)

      await new Promise((r) => setTimeout(r, 80))

      expect(engine.getRun(completed.id)).toBeNull()
      expect(engine.getEffects(completed.id)).toHaveLength(0)
      expect(engine.getRun(deferred.id)).not.toBeNull()
    })
  })
}

effectTests('memory', {})
effectTests('sqlite', { store: { type: 'sqlite', path: ':memory:' } })
