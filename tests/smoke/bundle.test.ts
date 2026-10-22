import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROOT_HELP } from '../../src/help.ts'
import { makeSandbox, type Sandbox, systemEnv } from '../harness.ts'

const bundle = fileURLToPath(new URL('../../dist/deepdock.js', import.meta.url))
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  version: string
  dependencies?: Record<string, string>
  bin: Record<string, string>
  engines: { node: string }
}

let box: Sandbox
beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => box.cleanup())

const node = (args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ...systemEnv(),
      HOME: box.home,
      APPDATA: join(box.home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: `${box.home}/.config`,
      NO_COLOR: '1',
    },
    cwd: box.work,
  })

describe('the bundle under node', () => {
  it('exists and is one file with no runtime dependencies', () => {
    expect(existsSync(bundle)).toBe(true)
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.bin.deepdock).toBe('dist/deepdock.js')
    expect(pkg.engines.node).toBe('>=22.13')
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('prints the package version', () => {
    const result = node(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${pkg.version}\n`)
  })

  it('prints the help', () => {
    const result = node(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(ROOT_HELP)
  })

  it('reports auth status without a sign-in, as JSON because stdout is a pipe', () => {
    const result = node(['auth', 'status'])
    expect(result.status).toBe(5)
    const doc = JSON.parse(String(result.stdout))
    expect(doc.data.signedIn).toBe(false)
  })

  it('answers a usage error as JSON with exit 1', () => {
    const result = node(['keys', 'create', '--expire'])
    expect(result.status).toBe(1)
    expect(JSON.parse(String(result.stderr)).error.code).toBe('invalid_usage')
  })

  it('installs the skill from the bundle location', () => {
    const result = node(['skill', '--agent', 'claude'])
    expect(result.status).toBe(0)
    expect(existsSync(`${box.work}/.claude/skills/deepdock/SKILL.md`)).toBe(true)
  })

  it('initialises the validation library only inside the schema loader', () => {
    const source = readFileSync(bundle, 'utf8')
    const loader =
      /var build = async \(\) => \{\s*await Promise\.resolve\(\)\.then\(\(\) => init_\w+\(\)\)/
    expect(loader.test(source)).toBe(true)
  })
})
