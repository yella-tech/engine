import { EngineError, ErrorCode } from './types.js'
import type { Handler, HandlerContext, HandlerResult, ProcessDefinition, RetryPolicy, Schema } from './types.js'

export function createRegistry() {
  const byEvent = new Map<string, ProcessDefinition[]>()
  const byName = new Map<string, ProcessDefinition>()

  function isSchema(value: Schema | Handler): value is Schema {
    return typeof value !== 'function' && value !== null && typeof value.parse === 'function'
  }

  type RegisterOpts = { retry?: RetryPolicy; version?: string; singleton?: boolean }

  function register(name: string, eventName: string, handler: Handler, opts?: RegisterOpts): void
  function register<T>(
    name: string,
    eventName: string,
    schema: Schema<T>,
    handler: (ctx: HandlerContext<T>) => Promise<HandlerResult> | HandlerResult,
    opts?: RegisterOpts,
  ): void
  function register(
    name: string,
    eventName: string,
    schemaOrHandler: Schema | Handler,
    maybeHandlerOrOpts?: Handler | RegisterOpts,
    maybeOpts?: RegisterOpts,
  ): void {
    if (byName.has(name)) throw new EngineError(ErrorCode.PROCESS_ALREADY_REGISTERED, `Process already registered: ${name}`)

    let handler: Handler
    let schema: Schema | undefined
    let retry: RetryPolicy | undefined
    let version: string | undefined
    let singleton: boolean | undefined

    if (typeof maybeHandlerOrOpts === 'function') {
      // 4+ arg form: register(name, event, schema, handler, opts?)
      if (!isSchema(schemaOrHandler)) {
        throw new Error('Schema is required when registering with a schema + handler')
      }
      schema = schemaOrHandler
      handler = maybeHandlerOrOpts
      retry = maybeOpts?.retry
      version = maybeOpts?.version
      singleton = maybeOpts?.singleton
    } else if (!isSchema(schemaOrHandler)) {
      // 3+ arg form: register(name, event, handler, opts?)
      handler = schemaOrHandler
      retry = (maybeHandlerOrOpts as RegisterOpts | undefined)?.retry
      version = (maybeHandlerOrOpts as RegisterOpts | undefined)?.version
      singleton = (maybeHandlerOrOpts as RegisterOpts | undefined)?.singleton
    } else {
      // Edge case: schema passed without handler, shouldn't happen but guard against it
      throw new Error('Handler is required when registering with a schema')
    }

    const def: ProcessDefinition = { name, eventName, handler, schema, retry, version, singleton }
    byName.set(name, def)

    const list = byEvent.get(eventName) ?? []
    list.push(def)
    byEvent.set(eventName, list)
  }

  function unregister(name: string): void {
    const def = byName.get(name)
    if (!def) return

    byName.delete(name)

    const list = byEvent.get(def.eventName)
    if (list) {
      const filtered = list.filter((d) => d.name !== name)
      if (filtered.length === 0) byEvent.delete(def.eventName)
      else byEvent.set(def.eventName, filtered)
    }
  }

  function getByEvent(eventName: string): ProcessDefinition[] {
    return byEvent.get(eventName) ?? []
  }

  function getAll(): ProcessDefinition[] {
    return [...byName.values()]
  }

  return { register, unregister, getByEvent, getAll }
}

export type Registry = ReturnType<typeof createRegistry>
