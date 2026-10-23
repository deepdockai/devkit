import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmPack } from './checkPublic.ts'
import { devEnv, reportFailure } from './devEnv.ts'

// Builds, packs the exact tarball npm would publish, and prints the one line that runs it from any
// directory against the same API and settings directory `bun run dev` would use.
const root = fileURLToPath(new URL('..', import.meta.url))

const PLAIN = /^[\w./:=@+-]+$/
const posixQuoted = (value: string): string =>
  PLAIN.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
const powershellQuoted = (value: string): string =>
  PLAIN.test(value) ? value : `'${value.replaceAll("'", "''")}'`

try {
  const env = devEnv({ env: process.env, platform: process.platform, homedir: homedir() })
  const { execFileSync } = await import('node:child_process')
  execFileSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  // A fresh private directory each time: a fixed name in the shared temp dir could be someone else's.
  const tarball = npmPack(root, mkdtempSync(join(tmpdir(), 'deepdock-cli-pack-')))
  const args = process.argv.length > 2 ? process.argv.slice(2) : ['auth', 'login']
  const windows = process.platform === 'win32'
  const quote = windows ? powershellQuoted : posixQuoted
  const command = ['npx', '-y', `--package=${tarball}`, 'deepdock', ...args].map(quote).join(' ')
  const assignments = Object.entries(env).map(([key, value]) =>
    windows ? `$env:${key}=${quote(value)};` : `${key}=${quote(value)}`,
  )
  process.stderr.write(`\nPacked ${tarball}\n\nRun it from any directory:\n\n`)
  process.stdout.write(`${assignments.join(' ')} ${command}\n`)
} catch (error) {
  reportFailure(error)
}
