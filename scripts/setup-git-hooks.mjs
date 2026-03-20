import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const gitDir = path.join(root, '.git')

if (!existsSync(gitDir)) {
  process.exit(0)
}

const hookPath = path.join(root, '.githooks')

const result = spawnSync('git', ['config', 'core.hooksPath', hookPath], {
  cwd: root,
  stdio: 'inherit',
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
