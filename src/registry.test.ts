import { describe, it, expect, beforeEach } from 'vitest'
import { createRegistry } from './registry.js'
import type { HandlerResult } from './types.js'

const noop = async (): Promise<HandlerResult> => ({ success: true })

describe('createRegistry', () => {
  let registry: ReturnType<typeof createRegistry>

  beforeEach(() => {
    registry = createRegistry()
  })

  describe('register', () => {
    it('stores a process retrievable by event', () => {
      registry.register('myProc', 'myEvent', noop)
      const defs = registry.getByEvent('myEvent')
      expect(defs).toHaveLength(1)
      expect(defs[0].name).toBe('myProc')
      expect(defs[0].eventName).toBe('myEvent')
      expect(defs[0].handler).toBe(noop)
    })

    it('supports multiple handlers on same event (fan-out)', () => {
      registry.register('a', 'shared', noop)
      registry.register('b', 'shared', noop)
      const defs = registry.getByEvent('shared')
      expect(defs).toHaveLength(2)
      expect(defs.map((d) => d.name)).toEqual(['a', 'b'])
    })

    it('throws on duplicate name', () => {
      registry.register('dup', 'event1', noop)
      expect(() => registry.register('dup', 'event2', noop)).toThrow('Process already registered: dup')
    })
  })

  describe('unregister', () => {
    it('removes process so it is no longer returned by getByEvent', () => {
      registry.register('proc', 'evt', noop)
      registry.unregister('proc')
      expect(registry.getByEvent('evt')).toHaveLength(0)
    })

    it('is a no-op for unknown name', () => {
      expect(() => registry.unregister('ghost')).not.toThrow()
    })

    it('cleans up event index when last handler removed', () => {
      registry.register('only', 'evt', noop)
      registry.unregister('only')
      expect(registry.getByEvent('evt')).toEqual([])
    })
  })

  describe('getByEvent', () => {
    it('returns empty array for unregistered event', () => {
      expect(registry.getByEvent('nope')).toEqual([])
    })
  })

  describe('getAll', () => {
    it('returns all registered processes', () => {
      registry.register('a', 'e1', noop)
      registry.register('b', 'e2', noop)
      registry.register('c', 'e1', noop)
      const all = registry.getAll()
      expect(all).toHaveLength(3)
      expect(all.map((d) => d.name).sort()).toEqual(['a', 'b', 'c'])
    })
  })
})
