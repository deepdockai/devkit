import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_ID, type FakeApi, KEY_ID, startFakeApi } from './fakeApi.ts'
import {
  execute,
  initRepo,
  makeSandbox,
  type Outcome,
  readConfigText,
  type Sandbox,
} from './harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  initRepo(box.work, '.env*\n')
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const filesBelow = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.name === '.git') return []
    return entry.isDirectory() ? filesBelow(path) : [path]
  })

describe('no secret on any stream', () => {
  it('keeps the sign-in secret, the key value and the poll secrets off stdout, stderr and the store', async () => {
    const seen: Outcome[] = []
    const run = async (
      argv: string[],
      options: Parameters<typeof execute>[2] = {},
      expectedExit = 0,
    ): Promise<Outcome> => {
      const outcome = await execute(box, argv, { baseUrl: api.url, ...options })
      expect(outcome.code, `${argv.join(' ')} -> ${outcome.stderr.slice(0, 200)}`).toBe(
        expectedExit,
      )
      seen.push(outcome)
      return outcome
    }
    const both = [{}, { tty: true }]

    for (const options of both) {
      await run(['auth', 'login', '--no-wait'], options)
    }
    await run(['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'])
    for (const options of both) {
      await run(['auth', 'status'], options)
      await run(['org', 'list'], options)
      await run(['org', 'select', 'muster-it'], options)
      await run(['systems', 'list'], options)
      await run(['systems', 'openapi', 'example-erp'], options)
      await run(['devices', 'list'], options)
      await run(['devices', 'pair', 'K7Q-4MX', '--label', 'Demo PC'], options)
      await run(['devices', 'rename', DEVICE_ID, 'Front desk'], options)
      await run(['devices', 'systems', DEVICE_ID], options)
      await run(['actions', 'list', DEVICE_ID, 'example-erp'], options)
      await run(['incidents', 'list'], options)
      await run(['keys', 'list'], options)
      await run(['skill', '--agent', 'claude'], options)
    }

    const createArgs = [
      'keys',
      'create',
      'myapp dev',
      '--expires',
      '30d',
      '--write-env',
      '.env.local',
    ]
    const started = await run([...createArgs, '--no-wait'])
    await run(['keys', 'create', '--wait', JSON.parse(started.stdout).data.pending.request])
    // The canary really flowed: the API handed a key out and the env file received it.
    expect(api.state.keysHandedOut).toBe(1)
    expect(readFileSync(join(box.work, '.env.local'), 'utf8')).toContain(
      `DEEPDOCK_API_KEY=${api.state.keyValue}`,
    )
    await run(['keys', 'revoke', KEY_ID, '--yes'])
    await run([...createArgs], { tty: true })
    expect(api.state.keysHandedOut).toBe(2)
    await run(['keys', 'revoke', KEY_ID], { tty: true, stdin: 'y\n' })
    await run([...createArgs, '--no-wait'])

    // Failures carry the API's text and must not carry a secret either.
    await run(
      ['keys', 'create', 'taken', '--expires', '7d', '--write-env', '.env.local', '--no-wait'],
      {},
      2,
    )
    await run(['devices', 'release', DEVICE_ID, '--yes', '--org', 'beispiel-handel'], {}, 2)
    await run(['devices', 'pair', 'WRONG'], {}, 2)
    await run(['bogus', '--json'], {}, 1)
    api.state.keyValue = 'invalid key value with spaces'
    await run([...createArgs, '--no-wait'])
    const lastRequest = JSON.parse(seen.at(-1)?.stdout || '{}').data?.pending?.request
    await run(['keys', 'create', '--wait', lastRequest ?? 'none'], {}, 3)

    await run(['auth', 'logout'], { tty: true })
    await run(['auth', 'logout', '--json'])

    const secrets = [
      api.state.signInSecret,
      'poll-login-secret',
      'poll-key-secret',
      'invalid key value with spaces',
    ]
    const valid = ['ddk', 'test', 'CANARYkey0123456789abcdefghij0123456789abcd'].join('_')
    for (const outcome of seen) {
      for (const secret of [...secrets, valid]) {
        expect(outcome.stdout).not.toContain(secret)
        expect(outcome.stderr).not.toContain(secret)
      }
    }
    expect(seen.length).toBeGreaterThan(30)
    // The config file never held the key value; it is checked after logout and, below, mid-flow.
    expect(readConfigText(box)).not.toContain(valid)
    expect(readConfigText(box)).not.toContain(api.state.signInSecret)
  })

  it('writes the key value only into the --write-env file and nowhere in the work tree or the store', async () => {
    await execute(box, ['auth', 'login', '--json'], { baseUrl: api.url })
    await execute(box, ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'], {
      baseUrl: api.url,
    })
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
    const args = ['keys', 'create', 'myapp dev', '--expires', '30d', '--write-env', '.env.local']
    const started = await execute(box, [...args, '--no-wait'], { baseUrl: api.url })
    const finished = await execute(
      box,
      ['keys', 'create', '--wait', JSON.parse(started.stdout).data.pending.request],
      { baseUrl: api.url },
    )
    expect(finished.code).toBe(0)

    const holders = [...filesBelow(box.work), ...filesBelow(box.home)].filter((file) =>
      readFileSync(file, 'utf8').includes(api.state.keyValue),
    )
    expect(holders).toEqual([join(box.work, '.env.local')])
    expect(statSync(box.configFile).size).toBeGreaterThan(0)
    expect(readConfigText(box)).toContain(api.state.signInSecret)
    expect(readConfigText(box)).not.toContain(api.state.keyValue)
    expect(started.stdout + started.stderr + finished.stdout + finished.stderr).not.toContain(
      api.state.keyValue,
    )
  })
})
