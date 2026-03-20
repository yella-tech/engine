import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  return result.stdout.trim()
}

const args = process.argv.slice(2)
const publish = args.includes('--publish')
const version = args.find((arg) => !arg.startsWith('-'))

if (args.includes('--help')) {
  console.log('Usage: node scripts/release.mjs <version> [--publish]')
  console.log('Example: node scripts/release.mjs 0.14.4 --publish')
  process.exit(0)
}

if (!version) {
  console.log('Usage: node scripts/release.mjs <version> [--publish]')
  console.log('Example: node scripts/release.mjs 0.14.4 --publish')
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`Invalid version "${version}". Expected semantic version like 0.14.4`)
}

const status = capture('git', ['status', '--porcelain'])
if (status.length > 0) {
  fail('Working tree must be clean before cutting a release.')
}

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const heading = new RegExp(`^## ${version} - `, 'm')
if (!heading.test(changelog)) {
  fail(`CHANGELOG.md must contain a heading like "## ${version} - YYYY-MM-DD" before releasing.`)
}

run('npm', ['version', version, '--no-git-tag-version'])
run('npm', ['run', 'format:check'])
run('npm', ['test'])
run('npm', ['run', 'build'])
run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md'])
run('git', ['commit', '-m', version])
run('git', ['tag', '-a', `v${version}`, '-m', version])

if (publish) {
  run('npm', ['publish'])
  run('git', ['push', 'origin', 'main', '--follow-tags'])
}
