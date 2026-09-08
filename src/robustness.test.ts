import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createDispatcher } from './dispatcher.js'
import { createRunStore } from './run.js'
import { applyMigrations } from './run-sqlite.js'
import { createEngine, ErrorCode } from './index.js'

describe('dispatcher survives a rejecting executeRun', () => {
  it('routes the rejection to onInternalError instead of leaving it unhandled', async () => {
    const store = createRunStore()
    store.create('proc', 'go', {})
    const internal: string[] = []
    const dispatcher = createDispatcher(
      store,
      async () => {
        throw new Error('store exploded before the try block')
      },
      1,
      undefined,
      (_err, context) => internal.push(context),
    )
    dispatcher.kick()
    await new Promise((r) => setTimeout(r, 20))
    expect(internal).toContain('executeRun')
    dispatcher.stop()
  })
})

describe('schema migrations are atomic', () => {
  it('a failing step leaves neither its own DDL nor earlier pending steps applied, and the version untouched', () => {
    const db = new Database(':memory:')
    const steps = [
      (d: Database.Database) => d.exec('CREATE TABLE first (id TEXT)'),
      (d: Database.Database) => {
        d.exec('CREATE TABLE second (id TEXT)')
        d.exec('CREATE TABLE second (id TEXT)') // fails: already exists
      },
    ]
    expect(() => applyMigrations(db, steps)).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([])
    db.close()
  })
})

describe('store option shapes', () => {
  let engine: ReturnType<typeof createEngine>
  afterEach(async () => {
    await engine?.stop()
  })

  it('{ type: "memory" } uses the in-memory store (payload keeps its Date)', async () => {
    let seen: unknown
    engine = createEngine({ store: { type: 'memory' } })
    engine.register('proc', 'go', async (ctx) => {
      seen = (ctx.payload as { when: unknown }).when
      return { success: true }
    })
    engine.emit('go', { when: new Date(0) })
    await engine.drain(2000)
    expect(seen).toBeInstanceOf(Date)
  })

  it('sqlite without a path is rejected as INVALID_CONFIG', () => {
    expect(() => createEngine({ store: { type: 'sqlite' } as any })).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_CONFIG }))
  })
})
