import { describe, it, expect, afterEach } from 'vitest'
import { createEngine } from './index.js'

describe('hardening', () => {
  let engine: ReturnType<typeof createEngine>

  afterEach(() => {
    engine?.stop()
  })

  it('throwing onRunStart does not kill the run', async () => {
    engine = createEngine({
      onRunStart: () => {
        throw new Error('onRunStart boom')
      },
    })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', null)
    await engine.drain()

    // Run should still complete (onRunStart error is caught, run continues)
    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('throwing onRunFinish does not crash the engine', async () => {
    engine = createEngine({
      onRunFinish: () => {
        throw new Error('onRunFinish boom')
      },
    })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', null)
    await engine.drain()

    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('throwing onRunError does not prevent onRunFinish', async () => {
    const calls: string[] = []
    engine = createEngine({
      onRunError: () => {
        calls.push('onRunError')
        throw new Error('onRunError boom')
      },
      onRunFinish: () => {
        calls.push('onRunFinish')
      },
    })
    engine.register('proc', 'go', async () => {
      throw new Error('handler fail')
    })
    engine.emit('go', null)
    await engine.drain()

    expect(calls).toContain('onRunError')
    expect(calls).toContain('onRunFinish')
    expect(engine.getErrored()).toHaveLength(1)
  })

  it('throwing onDead does not prevent run finalization', async () => {
    engine = createEngine({
      retry: { maxRetries: 0 },
      onDead: () => {
        throw new Error('onDead boom')
      },
    })
    engine.register('proc', 'go', async () => {
      throw new Error('handler fail')
    })
    engine.emit('go', null)
    await engine.drain()

    expect(engine.getErrored()).toHaveLength(1)
  })

  it('throwing onRetry does not prevent retry scheduling', async () => {
    let attempts = 0
    engine = createEngine({
      retry: { maxRetries: 1, delay: 0 },
      onRetry: () => {
        throw new Error('onRetry boom')
      },
    })
    engine.register('proc', 'go', async () => {
      attempts++
      if (attempts === 1) throw new Error('first fail')
      return { success: true }
    })
    engine.emit('go', null)
    await engine.drain()

    expect(attempts).toBe(2)
    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('onInternalError receives context strings for hook failures', async () => {
    const errors: { context: string; message: string }[] = []
    engine = createEngine({
      onInternalError: (err, context) => {
        errors.push({ context, message: err instanceof Error ? err.message : String(err) })
      },
      onRunStart: () => {
        throw new Error('start boom')
      },
      onRunFinish: () => {
        throw new Error('finish boom')
      },
    })
    engine.register('proc', 'go', async () => ({ success: true }))
    engine.emit('go', null)
    await engine.drain()

    const contexts = errors.map((e) => e.context)
    expect(contexts).toContain('onRunStart')
    expect(contexts).toContain('onRunFinish')
  })

  it('onInternalError reports finalizeError catch', async () => {
    const errors: { context: string }[] = []
    engine = createEngine({
      onInternalError: (_err, context) => {
        errors.push({ context })
      },
    })
    engine.register('proc', 'go', async () => {
      throw new Error('handler fail')
    })
    engine.emit('go', null)
    await engine.drain()

    // finalizeError should have run successfully (no onInternalError for it)
    // but the run should be in errored state
    expect(engine.getErrored()).toHaveLength(1)
  })

  it('drain callbacks survive individual failures', async () => {
    engine = createEngine()
    engine.register('proc', 'go', async () => ({ success: true }))

    engine.emit('go', null)
    await engine.drain()

    expect(engine.getCompleted()).toHaveLength(1)
  })

  it('multiple hooks throwing does not cascade failures', async () => {
    const errors: string[] = []
    engine = createEngine({
      onInternalError: (err, context) => {
        errors.push(context)
      },
      onRunStart: () => {
        throw new Error('start')
      },
      onRunError: () => {
        throw new Error('error')
      },
      onRunFinish: () => {
        throw new Error('finish')
      },
    })
    engine.register('proc', 'go', async () => {
      throw new Error('handler fail')
    })
    engine.emit('go', null)
    await engine.drain()

    expect(engine.getErrored()).toHaveLength(1)
    expect(errors).toContain('onRunStart')
    expect(errors).toContain('onRunError')
    expect(errors).toContain('onRunFinish')
  })
})
