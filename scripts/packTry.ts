import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packedFilename } from './checkPublic.ts'
import { splitTarget, targetEnv } from './devTargets.ts'

// Builds, packs the exact tarball npm would publish, and prints the one line that runs it from any
// directory: `bun run pack:try [--target <t>] [cli args]`.
const root = fileURLToPath(new URL('..', import.meta.url))
const split = splitTarget(process.argv.slice(2), process.env)
if ('error' in split) {
  process.stderr.write(`${split.error}\n`)
  process.exit(2)
}

const outDir = join(tmpdir(), 'deepdock-cli-pack')
mkdirSync(outDir, { recursive: true })
execFileSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const packed = execFileSync('npm', ['pack', '--json', '--silent', '--pack-destination', outDir], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
const tarball = resolve(outDir, packedFilename(packed))

const env = targetEnv(split.target, {
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
})
const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`)
const args = split.rest.length > 0 ? split.rest.join(' ') : 'auth login'
process.stderr.write(`\nPacked ${tarball}\n\nRun it (${split.target}) from any directory:\n\n`)
process.stdout.write(`${assignments.join(' ')} npx -y --package=${tarball} deepdock ${args}\n`)
if (process.platform === 'win32') {
  process.stderr.write(
    '\nOn Windows set the two variables first ($env:NAME = "value"), then run the npx part.\n',
  )
}
