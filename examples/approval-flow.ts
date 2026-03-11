import fs from 'node:fs'
import { createEngine, getRunStatus, type EngineEvent } from '../src/index.js'

const dbPath = '_db/approval-flow.db'
fs.mkdirSync('_db', { recursive: true })
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

let crmOnline = false
const dashboardEnabled = process.env.ENGINE_NO_SERVER !== '1'

function logEvent(event: EngineEvent): void {
  switch (event.type) {
    case 'run:retry':
      console.log(`[retry] ${event.run.processName} #${event.attempt}: ${event.error}`)
      break
    case 'run:dead':
      console.log(`[dead-letter] ${event.run.processName}: ${event.error}`)
      break
    case 'run:resume':
      console.log(`[resume] ${event.resumedRun.processName} -> ${event.childRuns.map((run) => run.processName).join(', ')}`)
      break
  }
}

const engine = createEngine({
  store: { type: 'sqlite', path: dbPath },
  concurrency: 4,
  retention: '7d',
  ...(dashboardEnabled ? { server: { port: 3400 } } : {}),
  onEvent: logEvent,
})

engine.process({
  name: 'review-gate',
  on: 'content:drafted',
  emits: ['content:approved'],
  run: async (ctx) => {
    const payload = ctx.payload as { title?: string }
    const title = payload.title ?? 'Untitled draft'
    console.log(`[review] Draft ready: ${title}`)
    return {
      success: true,
      payload: { title, reviewer: 'editor@yella.tech' },
      triggerEvent: 'content:approved',
      deferred: true,
    }
  },
})

engine.process({
  name: 'publish-blog',
  on: 'content:approved',
  emits: ['content:published'],
  run: async (ctx) => {
    await wait(120)
    const payload = ctx.payload as { title: string }
    console.log(`[publish] Blog published: ${payload.title}`)
    return ctx.ok({ title: payload.title, slug: slugify(payload.title) }, { emit: 'content:published' })
  },
})

engine.process({
  name: 'sync-to-crm',
  on: 'content:approved',
  retry: { maxRetries: 1, delay: 250 },
  run: async (ctx) => {
    await wait(80)
    if (!crmOnline) throw new Error('CRM API timeout')
    const payload = ctx.payload as { title: string }
    console.log(`[crm] Synced: ${payload.title}`)
    return ctx.ok({ synced: true })
  },
})

engine.process({
  name: 'announce',
  on: 'content:published',
  run: async (ctx) => {
    const payload = ctx.payload as { slug: string }
    console.log(`[announce] Social post queued for ${payload.slug}`)
    return ctx.ok()
  },
})

process.on('SIGINT', async () => {
  await engine.stop()
  process.exit(0)
})

async function main() {
  const server = await engine.getServer()
  if (server) {
    console.log(`Dashboard: http://${server.address.host}:${server.address.port}`)
  }

  console.log('\nSubmitting draft...')
  engine.emit('content:drafted', { title: 'Deferred approvals without a platform' })
  await engine.drain()

  const deferred = engine.getCompleted().find((run) => getRunStatus(run) === 'deferred')
  if (!deferred) throw new Error('Expected a deferred review-gate run')

  console.log(`\n[status] ${deferred.processName} is ${getRunStatus(deferred)}`)
  console.log('[metrics after defer]')
  console.dir(engine.getMetrics(), { depth: null })

  await wait(1000)
  console.log('\n[approval] Reviewer approved the draft, resuming chain...')
  engine.resume(deferred.id)
  await engine.drain()

  const [deadLetter] = engine.getErrored().filter((run) => getRunStatus(run) === 'dead-letter')
  if (deadLetter) {
    console.log(`\n[status] ${deadLetter.processName} is ${getRunStatus(deadLetter)} (${deadLetter.result?.error})`)
    console.log('[repair] CRM is back online, requeueing dead-letter run...')
    crmOnline = true
    engine.requeueDead(deadLetter.id)
    await engine.drain()
  }

  console.log('\n[metrics final]')
  console.dir(engine.getMetrics(), { depth: null })
  console.log(
    'Completed runs:',
    engine.getCompleted().map((run) => `${run.processName}:${getRunStatus(run)}`).join(', '),
  )
  if (!dashboardEnabled) {
    await engine.stop()
    return
  }
  console.log('\nPress Ctrl+C to stop')
}

main().catch(async (err) => {
  console.error(err)
  await engine.stop({ graceful: false })
  process.exit(1)
})
