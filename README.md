# @yella/engine

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Crash-proof background jobs for TypeScript. Side effects run once, retries skip what already worked.

## Install

```bash
npm install @yella/engine
```

## Quick Start

```typescript
import { createEngine } from '@yella/engine'

const engine = createEngine()

engine.process({
  name: 'greet',
  on: 'user:signup',
  run: async (ctx) => {
    console.log(`Welcome, ${ctx.payload.name}!`)
    return ctx.ok()
  },
})

await engine.emitAndWait('user:signup', { name: 'Alice' })
await engine.stop()
```

## Docs

[yella.tech](https://yella.tech)

## License

[AGPL-3.0](LICENSE)
