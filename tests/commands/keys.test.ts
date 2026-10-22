import { execFileSync } from 'node:child_process'
import {
  existsSync,
  promises as fs,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeApi, KEY_ID, startFakeApi } from '../fakeApi.ts'
import {
  errorDocOf,
  execute,
  initRepo,
  makeSandbox,
  readConfigText,
  type Sandbox,
  signInWith,
} from '../harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  await signInWith(box, api.url)
  await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
  initRepo(box.work, '.env*\n')
  api.requests.length = 0
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const run = (argv: string[], options: Parameters<typeof execute>[2] = {}) =>
  execute(box, argv, { baseUrl: api.url, ...options })

const createArgs = ['keys', 'create', 'myapp dev', '--expires', '30d', '--write-env', '.env.local']
const envFile = (): string => join(box.work, '.env.local')

/** Off a terminal creation is two steps: start with --no-wait, finish with --wait. */
const createFully = async (
  args: string[] = createArgs,
  options: Parameters<typeof execute>[2] = {},
): Promise<Awaited<ReturnType<typeof execute>>> => {
  const started = await run([...args, '--no-wait'], options)
  if (started.code !== 0) return started
  return run(['keys', 'create', '--wait', JSON.parse(started.stdout).data.pending.request], options)
}

describe('keys create', () => {
  it('writes the key to the file and prints no value, only named fields', async () => {
    const started = await run([...createArgs, '--no-wait'])
    expect(started.code).toBe(0)
    const request = JSON.parse(started.stdout).data.pending.request as string
    expect(existsSync(envFile())).toBe(false)

    const finished = await run(['keys', 'create', '--wait', request])
    expect(finished.code).toBe(0)
    const doc = JSON.parse(finished.stdout)
    expect(Object.keys(doc.data).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'prefix'])
    expect(doc.meta.written).toEqual({ file: '.env.local', name: 'DEEPDOCK_API_KEY' })
    expect(doc.meta.org.slug).toBe('muster-it')
    expect(readFileSync(envFile(), 'utf8')).toBe(`DEEPDOCK_API_KEY=${api.state.keyValue}\n`)
    if (process.platform !== 'win32') expect(statSync(envFile()).mode & 0o777).toBe(0o600)
    expect(finished.stdout + finished.stderr).not.toContain(api.state.keyValue)
  })

  it('records id, org, name, prefix, expiry, file and variable and nothing else', async () => {
    const started = await run([...createArgs, '--no-wait'])
    await run(['keys', 'create', '--wait', JSON.parse(started.stdout).data.pending.request])
    const config = JSON.parse(readConfigText(box))
    expect(config.keys).toEqual([
      {
        org: 'muster-it',
        id: KEY_ID,
        name: 'myapp dev',
        prefix: api.state.keyValue.slice(9, 17),
        expiresAt: expect.any(String),
        file: envFile(),
        variable: 'DEEPDOCK_API_KEY',
      },
    ])
    expect(config.pending).toEqual([])
  })

  it('on a terminal waits, prints the link on stderr and the summary on stdout', async () => {
    const outcome = await run(createArgs, { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toContain(
      'Open this link to approve the key (it expires in 10 minutes):',
    )
    expect(outcome.stderr).toContain('A human approves "Create an API key in Muster IT?" there')
    expect(outcome.stdout).toContain('Created API key "myapp dev".')
    expect(outcome.stdout).toContain(`ID:        ${KEY_ID}`)
    expect(outcome.stdout).toContain('Written:   .env.local (DEEPDOCK_API_KEY)')
    expect(outcome.stdout).toContain('keeps no copy')
    expect(outcome.stdout + outcome.stderr).not.toContain(api.state.keyValue)
  })

  it('sends the name, an expiry about 30 days out, the hostname and the CLI version', async () => {
    await run([...createArgs, '--no-wait'], { hostname: 'build-box' })
    const body = api.requests.find((entry) => entry.path === '/partner/key-requests')
      ?.body as Record<string, string>
    expect(body.name).toBe('myapp dev')
    expect(body.hostname).toBe('build-box')
    expect(body.cliVersion).toBe('0.1.0')
    const days = (Date.parse(body.expiresAt ?? '') - Date.now()) / 86400000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
  })

  it('replaces an existing line in place', async () => {
    writeFileSync(envFile(), 'A=1\nDEEPDOCK_API_KEY=old\nB=2\n')
    await createFully()
    expect(readFileSync(envFile(), 'utf8')).toBe(
      `A=1\nDEEPDOCK_API_KEY=${api.state.keyValue}\nB=2\n`,
    )
  })

  it('refuses a file git does not ignore before any request', async () => {
    const outcome = await run([
      'keys',
      'create',
      'x',
      '--expires',
      '30d',
      '--write-env',
      'secrets.txt',
    ])
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.message).toBe(
      'secrets.txt is not ignored by git, so the key would be committed.',
    )
    expect(api.requests).toHaveLength(0)
  })

  it('refuses a tracked file before any request', async () => {
    writeFileSync(envFile(), 'A=1\n')
    execFileSync('git', ['add', '-f', '.env.local'], { cwd: box.work })
    const outcome = await run(createArgs)
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.message).toContain('tracked by git')
    expect(api.requests).toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink before any request', async () => {
    writeFileSync(join(box.work, 'real'), '')
    symlinkSync(join(box.work, 'real'), envFile())
    const outcome = await run(createArgs)
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.message).toContain('symbolic link')
    expect(api.requests).toHaveLength(0)
  })

  it('outside a repository writes with a warning on stderr', async () => {
    const outside = makeSandbox()
    try {
      const started = await run([...createArgs.slice(0, -1), '.env', '--no-wait'], {
        cwd: outside.work,
      })
      expect(started.stderr).toContain('Warning:')
      expect(started.stderr).toContain(
        'is not inside a git repository; make sure it is never committed or shared.',
      )
      const request = JSON.parse(started.stdout).data.pending.request as string
      const outcome = await run(['keys', 'create', '--wait', request], { cwd: outside.work })
      expect(outcome.code).toBe(0)
      expect(readFileSync(join(outside.work, '.env'), 'utf8')).toContain('DEEPDOCK_API_KEY=')
    } finally {
      outside.cleanup()
    }
  })

  const gitFailures: [string, (dir: string) => string, string][] = [
    ['git is not installed', (dir) => dir, 'git is not installed'],
    [
      'a permission error',
      () => 'echo "fatal: cannot open: Permission denied" >&2; exit 1',
      'git failed: fatal: cannot open: Permission denied',
    ],
    [
      'dubious ownership',
      () => 'echo "fatal: detected dubious ownership in repository" >&2; exit 128',
      'git reported dubious ownership',
    ],
    ['a generic failure exit', () => 'exit 7', 'git failed: exit 7'],
  ]

  for (const [kind, script, reason] of gitFailures) {
    it.skipIf(process.platform === 'win32')(
      `writes the file with a warning when git cannot answer: ${kind}`,
      async () => {
        const bin = join(box.work, '..', `bin-${Math.random().toString(36).slice(2)}`)
        mkdirSync(bin)
        if (kind !== 'git is not installed') {
          writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script(bin)}\n`, { mode: 0o755 })
        }
        const options = { env: { PATH: bin } }
        const started = await run([...createArgs, '--no-wait'], options)
        expect(started.code).toBe(0)
        const warning = `Warning: could not check with git whether .env.local is ignored: ${reason}; make sure it is not committed.`
        expect(started.stderr).toContain(warning)
        const request = JSON.parse(started.stdout).data.pending.request as string
        const finished = await run(['keys', 'create', '--wait', request], options)
        expect(finished.code).toBe(0)
        expect(finished.stderr).toContain('could not check with git whether')
        expect(finished.stderr).toContain(
          `.env.local is ignored: ${reason}; make sure it is not committed.`,
        )
        expect(readFileSync(envFile(), 'utf8')).toBe(`DEEPDOCK_API_KEY=${api.state.keyValue}\n`)
        if (process.platform !== 'win32') expect(statSync(envFile()).mode & 0o777).toBe(0o600)
        for (const outcome of [started, finished]) {
          expect(outcome.stdout + outcome.stderr).not.toContain(api.state.keyValue)
        }
        expect(readdirSync(box.work).filter((name) => name.includes('deepdock-tmp'))).toEqual([])
      },
    )
  }

  it('on Windows the run that writes the env file says both files keep their folder permissions', async () => {
    const windows = { platform: 'win32' as const, env: { APPDATA: join(box.home, 'AppData') } }
    await signInWith(box, api.url, windows)
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url, ...windows })
    const settings = join(box.home, 'AppData', 'deepdock', 'config.json')
    const sentence = `On Windows these files keep the permissions of their folder: ${envFile()} and the settings file ${settings} hold secrets; under C:\\Users\\<you> only you can read them, in other folders other users of this PC may be able to.`
    const started = await run([...createArgs, '--no-wait'], windows)
    expect(started.code).toBe(0)
    expect(started.stderr).not.toContain('On Windows')
    const request = JSON.parse(started.stdout).data.pending.request as string
    const finished = await run(['keys', 'create', '--wait', request], windows)
    expect(finished.code).toBe(0)
    expect(finished.stderr.split(sentence)).toHaveLength(2)
    expect(started.stdout + started.stderr + finished.stdout + finished.stderr).not.toContain(
      api.state.keyValue,
    )
    const other = await run(['org', 'list'], windows)
    expect(other.stderr).not.toContain('On Windows')
  })

  it('an interactive run on Windows prints the line once', async () => {
    const windows = { platform: 'win32' as const, env: { APPDATA: join(box.home, 'AppData') } }
    await signInWith(box, api.url, windows)
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url, ...windows })
    const outcome = await run(createArgs, { ...windows, tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stderr.split('On Windows these files').length).toBe(2)
  })

  // A Windows host cannot play another platform: the file system, the paths and git stay the host's.
  // The property is checked on the Linux and macOS runners.
  it.skipIf(process.platform === 'win32')(
    'on other platforms the line is never printed',
    async () => {
      // Signed in under the simulated platform too: the settings file's place depends on it, so a
      // sign-in made under the host's own platform would not be found on a Windows host.
      const linux = { platform: 'linux' as const }
      await signInWith(box, api.url, linux)
      await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url, ...linux })
      const started = await run([...createArgs, '--no-wait'], linux)
      expect(started.code).toBe(0)
      const finished = await run(
        ['keys', 'create', '--wait', JSON.parse(started.stdout).data.pending.request],
        linux,
      )
      expect(finished.code).toBe(0)
      expect(started.stderr + finished.stderr).not.toContain('On Windows')
    },
  )

  it('needs a destination, an allowed expiry and a name', async () => {
    const noDestination = await run(['keys', 'create', 'x', '--expires', '30d'])
    expect(noDestination.code).toBe(1)
    expect(errorDocOf(noDestination.stderr).error.message).toBe('The key needs a destination.')
    const badExpiry = await run([
      'keys',
      'create',
      'x',
      '--expires',
      '1y',
      '--write-env',
      '.env.local',
    ])
    expect(badExpiry.code).toBe(1)
    expect(errorDocOf(badExpiry.stderr).meta.hint).toContain('90 days is the maximum')
    const noExpiry = await run(['keys', 'create', 'x', '--write-env', '.env.local'])
    expect(noExpiry.code).toBe(1)
    const noName = await run(['keys', 'create', '--expires', '7d', '--write-env', '.env.local'])
    expect(noName.code).toBe(1)
    expect(api.requests).toHaveLength(0)
  })

  it('answers a name conflict with exit 2', async () => {
    const outcome = await run([
      'keys',
      'create',
      'taken',
      '--expires',
      '7d',
      '--write-env',
      '.env.local',
    ])
    expect(outcome.code).toBe(2)
    expect(errorDocOf(outcome.stderr).error.code).toBe('conflict')
  })

  it('answers a member with forbidden, exit 2', async () => {
    const outcome = await run([...createArgs, '--org', 'beispiel-handel'])
    expect(outcome.code).toBe(2)
    expect(errorDocOf(outcome.stderr).error.code).toBe('forbidden')
  })

  it('answers a denial with exit 5 and writes nothing', async () => {
    api.state.keyPolls.splice(0, api.state.keyPolls.length, 'denied')
    const outcome = await run(createArgs, { tty: true })
    expect(outcome.code).toBe(5)
    expect(outcome.stderr).toContain('The key request was denied in the browser [approval_denied].')
    expect(existsSync(envFile())).toBe(false)
  })

  it('revokes a key it cannot deliver and never echoes the value', async () => {
    api.state.keyValue = 'not a valid key value with spaces'
    const outcome = await createFully()
    expect(outcome.code).toBe(3)
    expect(api.state.revokedKeys).toEqual([KEY_ID])
    expect(outcome.stdout + outcome.stderr).not.toContain('not a valid key value')
    expect(existsSync(envFile())).toBe(false)
    expect(JSON.parse(readConfigText(box)).keys).toEqual([])
  })

  it('re-checks the destination after the approval: tracked during the wait revokes the key', async () => {
    writeFileSync(envFile(), 'A=1\n')
    api.state.keyPolls.splice(0, api.state.keyPolls.length, 'pending', 'approved')
    const started = await run([...createArgs, '--no-wait'])
    const request = JSON.parse(started.stdout).data.pending.request as string
    const outcome = await run(['keys', 'create', '--wait', request], {
      onSleep: () => {
        execFileSync('git', ['add', '-f', '.env.local'], { cwd: box.work })
      },
    })
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.message).toContain('tracked by git')
    expect(api.state.revokedKeys).toEqual([KEY_ID])
    expect(readFileSync(envFile(), 'utf8')).toBe('A=1\n')
    expect(JSON.parse(readConfigText(box)).keys).toEqual([])
    expect(outcome.stdout + outcome.stderr).not.toContain(api.state.keyValue)
  })

  it('un-ignoring during the wait is caught the same way', async () => {
    api.state.keyPolls.splice(0, api.state.keyPolls.length, 'pending', 'approved')
    const started = await run([...createArgs, '--no-wait'])
    const request = JSON.parse(started.stdout).data.pending.request as string
    const outcome = await run(['keys', 'create', '--wait', request], {
      onSleep: () => writeFileSync(join(box.work, '.gitignore'), ''),
    })
    expect(outcome.code).toBe(1)
    expect(api.state.revokedKeys).toEqual([KEY_ID])
    expect(existsSync(envFile())).toBe(false)
  })

  it('records the key in the ledger before writing, and keeps it when the revoke fails', async () => {
    api.state.keyValue = 'not a valid key value with spaces'
    api.state.forced[`DELETE /partner/keys/${KEY_ID}`] = {
      status: 500,
      body: { error: { code: 'internal_error', message: 'boom' } },
    }
    const outcome = await createFully()
    expect(outcome.code).toBe(3)
    expect(errorDocOf(outcome.stderr).meta.hint).toContain(`deepdock keys revoke ${KEY_ID}`)
    const config = JSON.parse(readConfigText(box))
    expect(config.keys).toHaveLength(1)
    expect(config.keys[0]).toMatchObject({ id: KEY_ID, org: 'muster-it', name: 'myapp dev' })
    expect(config.pending).toEqual([])
    expect(outcome.stdout + outcome.stderr).not.toContain('not a valid key value')
  })

  it('says a key may exist when the connection drops while polling, and keeps the request', async () => {
    const started = await run([...createArgs, '--no-wait'])
    const request = JSON.parse(started.stdout).data.pending.request as string
    const outcome = await run(['keys', 'create', '--wait', request], {
      fetch: (input, init) => {
        if (input.endsWith('/poll')) return Promise.reject(new TypeError('socket closed'))
        return fetch(input, init)
      },
    })
    expect(outcome.code).toBe(3)
    const error = errorDocOf(outcome.stderr)
    expect(error.error.code).toBe('connection_lost')
    expect(error.error.message).toContain('a key may exist')
    expect(error.meta.hint).toContain('deepdock keys list')
    expect(error.meta.hint).toContain(`--wait ${request}`)
    expect(JSON.parse(readConfigText(box)).pending).toHaveLength(1)
  })

  it('a Ctrl-C during the wait exits 3, keeps the request and resumes with --wait', async () => {
    api.state.keyPolls.splice(0, api.state.keyPolls.length, 'pending', 'approved')
    const interrupted = await run(createArgs, { tty: true, interruptAtSleep: true })
    expect(interrupted.code).toBe(3)
    expect(interrupted.stderr).toContain('[connection_lost]')
    const pending = JSON.parse(readConfigText(box)).pending as { request: string }[]
    expect(pending).toHaveLength(1)
    expect(interrupted.stderr).toContain(`deepdock keys create --wait ${pending[0]?.request}`)
    expect(existsSync(envFile())).toBe(false)
    const resumed = await run(['keys', 'create', '--wait', pending[0]?.request ?? ''])
    expect(resumed.code).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
  })

  it('keeps several requests pending at once and removes only the finished one', async () => {
    const first = await run([...createArgs, '--no-wait'])
    const second = await run([
      'keys',
      'create',
      'second',
      '--expires',
      '7d',
      '--write-env',
      '.env.local',
      '--no-wait',
    ])
    const firstId = JSON.parse(first.stdout).data.pending.request as string
    const secondId = JSON.parse(second.stdout).data.pending.request as string
    expect(firstId).not.toBe(secondId)
    expect((JSON.parse(readConfigText(box)).pending as unknown[]).length).toBe(2)
    await run(['keys', 'create', '--wait', firstId])
    const left = JSON.parse(readConfigText(box)).pending as { request: string }[]
    expect(left.map((entry) => entry.request)).toEqual([secondId])
  })

  it('prunes requests long expired when the settings are read, but keeps recent ones', async () => {
    await run([...createArgs, '--no-wait'])
    const soon = (): Date => new Date(Date.now() + 30 * 60_000)
    await run(['org', 'list'], { now: soon })
    expect(JSON.parse(readConfigText(box)).pending).toHaveLength(1)
    const muchLater = (): Date => new Date(Date.now() + 3 * 3600_000)
    await run(['org', 'list'], { now: muchLater })
    expect(JSON.parse(readConfigText(box)).pending).toEqual([])
  })

  it('--wait re-checks the destination when it changed in the meantime', async () => {
    const started = await run([...createArgs, '--no-wait'])
    writeFileSync(join(box.work, '.gitignore'), '')
    const outcome = await run([
      'keys',
      'create',
      '--wait',
      JSON.parse(started.stdout).data.pending.request,
    ])
    expect(outcome.code).toBe(1)
    expect(api.requests.some((entry) => entry.path === '/partner/key-requests/poll')).toBe(false)
  })
})

describe('keys revoke', () => {
  const createKey = async (): Promise<void> => {
    await createFully()
    api.requests.length = 0
  }

  it('without a terminal and without --yes stops before any request', async () => {
    const outcome = await run(['keys', 'revoke', KEY_ID])
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).meta.hint).toBe('Run it again with --yes.')
    expect(api.requests).toHaveLength(0)
  })

  it('asks on a terminal, then revokes and removes the line it wrote', async () => {
    await createKey()
    const outcome = await run(['keys', 'revoke', KEY_ID], { tty: true, stdin: 'y\n' })
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toContain('Revoke API key "myapp dev"')
    expect(outcome.stderr).toContain('Every program using it stops working at once. [y/N]')
    expect(outcome.stdout).toContain(
      'Revoked API key "myapp dev" and removed the DEEPDOCK_API_KEY line from .env.local.',
    )
    expect(readFileSync(envFile(), 'utf8')).toBe('')
    expect(JSON.parse(readConfigText(box)).keys).toEqual([])
    expect(api.state.revokedKeys).toEqual([KEY_ID])
  })

  it('does nothing on no', async () => {
    await createKey()
    const outcome = await run(['keys', 'revoke', KEY_ID], { tty: true, stdin: 'n\n' })
    expect(outcome.code).toBe(1)
    expect(api.state.revokedKeys).toEqual([])
    expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
  })

  it('--yes under --json reports removed', async () => {
    await createKey()
    const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data).toEqual({
      id: KEY_ID,
      revokedAt: '2026-10-21T15:20:44Z',
      removed: { file: '.env.local', name: 'DEEPDOCK_API_KEY', removal: 'done' },
    })
  })

  it('a key this CLI did not create has removed null', async () => {
    const outcome = await run(['keys', 'revoke', 'k_other-key', '--yes', '--json'])
    expect(JSON.parse(outcome.stdout).data.removed).toBeNull()
  })

  it('logout revokes the recorded keys by id and removes their lines', async () => {
    await createKey()
    const outcome = await run(['auth', 'logout', '--json'], { hostname: 'test-host' })
    expect(outcome.code).toBe(0)
    expect(api.state.revokedKeys).toEqual([KEY_ID])
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.apiKeysRevoked[0]).toMatchObject({
      id: KEY_ID,
      org: 'muster-it',
      removed: { file: '.env.local', removal: 'done' },
    })
    expect(readFileSync(envFile(), 'utf8')).toBe('')
    expect(JSON.parse(readConfigText(box)).keys).toEqual([])
  })

  it('revoke finds the line whatever way it was written: quotes, export, CRLF', async () => {
    for (const [wrap, eol] of [
      [(value: string) => value.replace('=', '="').concat('"'), '\n'],
      [(value: string) => `export ${value}`, '\n'],
      [(value: string) => value, '\r\n'],
    ] as const) {
      await createKey()
      const line = readFileSync(envFile(), 'utf8').trim()
      writeFileSync(envFile(), `A=1${eol}${wrap(line)}${eol}`)
      const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
      expect(JSON.parse(outcome.stdout).data.removed).toEqual({
        file: '.env.local',
        name: 'DEEPDOCK_API_KEY',
        removal: 'done',
      })
      expect(readFileSync(envFile(), 'utf8')).not.toContain('DEEPDOCK_API_KEY')
      expect(readFileSync(envFile(), 'utf8')).toContain('A=1')
    }
  })

  it('revoke leaves a DEEPDOCK_API_KEY line holding another value alone', async () => {
    await createKey()
    writeFileSync(envFile(), 'DEEPDOCK_API_KEY=somebody-elses-own-key-value\n')
    const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
    expect(JSON.parse(outcome.stdout).data.removed).toEqual({
      file: '.env.local',
      name: 'DEEPDOCK_API_KEY',
      removal: 'absent',
    })
    expect(readFileSync(envFile(), 'utf8')).toBe('DEEPDOCK_API_KEY=somebody-elses-own-key-value\n')
    expect(api.state.revokedKeys).toEqual([KEY_ID])
  })

  it('logout with a still-live key revokes it, removes its line and keeps the other lines', async () => {
    await createKey()
    writeFileSync(envFile(), `A=1\nDEEPDOCK_API_KEY=${api.state.keyValue}\nB=2\n`)
    const outcome = await run(['auth', 'logout', '--json'])
    const doc = JSON.parse(outcome.stdout)
    expect(api.state.revokedKeys).toEqual([KEY_ID])
    expect(doc.data.apiKeysRevoked[0].removed).toEqual({
      file: '.env.local',
      name: 'DEEPDOCK_API_KEY',
      removal: 'done',
    })
    expect(readFileSync(envFile(), 'utf8')).toBe('A=1\nB=2\n')
    expect(JSON.parse(readConfigText(box)).keys).toEqual([])
  })

  describe('when the env file is held open by another program', () => {
    // An injected failure, not a real OS lock, so it behaves the same on every platform.
    const hold = (code: string): void => {
      const real = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith('.env.local')) {
          throw Object.assign(new Error(`${code}: resource busy or locked`), { code })
        }
        return real(from, to)
      })
    }
    afterEach(() => vi.restoreAllMocks())

    const expectedWarning =
      'Warning: could not remove DEEPDOCK_API_KEY from .env.local (another program has the file open): the key is revoked, delete the line by hand.'

    for (const code of ['EBUSY', 'EPERM']) {
      it(`keys revoke still succeeds and says the line is still there (${code})`, async () => {
        await createKey()
        hold(code)
        const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
        expect(outcome.code).toBe(0)
        expect(api.state.revokedKeys).toEqual([KEY_ID])
        expect(outcome.stderr).toContain(expectedWarning)
        expect(JSON.parse(outcome.stdout).data.removed).toEqual({
          file: '.env.local',
          name: 'DEEPDOCK_API_KEY',
          removal: 'failed',
          reason: 'another program has the file open',
        })
        expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
        expect(readdirSync(box.work).filter((name) => name.includes('deepdock-tmp'))).toEqual([])
        expect(outcome.stdout + outcome.stderr).not.toContain(api.state.keyValue)
        expect(JSON.parse(readConfigText(box)).keys).toHaveLength(1)
      })
    }

    it('the human output says to delete the line by hand', async () => {
      await createKey()
      hold('EBUSY')
      const outcome = await run(['keys', 'revoke', KEY_ID, '--yes'], { tty: true })
      expect(outcome.code).toBe(0)
      // The failure is reported once, on stderr; stdout does not repeat it.
      expect(outcome.stdout).toBe('Revoked API key "myapp dev".\n')
      expect(outcome.stderr).toContain('delete the line by hand')
    })

    it('running revoke again once the file is free removes the line and the entry', async () => {
      await createKey()
      hold('EBUSY')
      await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
      vi.restoreAllMocks()
      api.state.forced[`DELETE /partner/keys/${KEY_ID}`] = {
        status: 404,
        body: { error: { code: 'not_found', message: 'No such key.' } },
      }
      const again = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
      expect(again.code).toBe(0)
      expect(JSON.parse(again.stdout).data.removed.removal).toBe('done')
      expect(JSON.parse(again.stdout).data.alreadyRevoked).toBe(true)
      expect(readFileSync(envFile(), 'utf8')).not.toContain('DEEPDOCK_API_KEY')
      expect(JSON.parse(readConfigText(box)).keys).toEqual([])
    })

    it('auth logout revokes the key, reports the failed removal and clears its records', async () => {
      await createKey()
      hold('EPERM')
      const outcome = await run(['auth', 'logout', '--json'])
      expect(outcome.code).toBe(0)
      expect(api.state.revokedKeys).toEqual([KEY_ID])
      expect(outcome.stderr).toContain(expectedWarning)
      const doc = JSON.parse(outcome.stdout)
      expect(doc.data.apiKeysRevoked[0].removed).toEqual({
        file: '.env.local',
        name: 'DEEPDOCK_API_KEY',
        removal: 'failed',
        reason: 'another program has the file open',
      })
      expect(doc.meta.hint).toBe('Delete DEEPDOCK_API_KEY from .env.local by hand.')
      expect(outcome.stdout + outcome.stderr).not.toContain(api.state.keyValue)
      expect(JSON.parse(readConfigText(box)).keys).toEqual([])
      expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
    })

    it('the human logout summary does not claim the line was removed', async () => {
      await createKey()
      hold('EBUSY')
      const outcome = await run(['auth', 'logout'], { tty: true })
      expect(outcome.stdout).toContain('Revoked the API keys this CLI created:')
      expect(outcome.stdout).not.toContain('removed the entries')
      expect(outcome.stdout).not.toContain('still in')
      expect(outcome.stderr.split('delete the line by hand')).toHaveLength(2)
    })

    it('after such a logout, signing in again and revoking finds nothing surprising', async () => {
      await createKey()
      hold('EBUSY')
      await run(['auth', 'logout', '--json'])
      vi.restoreAllMocks()
      await signInWith(box, api.url)
      await run(['org', 'select', 'muster-it'])
      const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
      expect(outcome.code).toBe(0)
      expect(JSON.parse(outcome.stdout).data.removed).toBeNull()
      expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
    })

    it('a second logout while signed out says nothing misleading', async () => {
      await createKey()
      hold('EBUSY')
      await run(['auth', 'logout', '--json'])
      const again = await run(['auth', 'logout'], { tty: true })
      expect(again.code).toBe(0)
      expect(again.stdout).toBe('Not signed in.\n')
      expect(again.stderr).toBe('')
    })

    it('a read failure on the env file counts as a failed removal', async () => {
      await createKey()
      const real = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>
      vi.spyOn(fs, 'readFile').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
        if (String(path).endsWith('.env.local')) {
          throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' })
        }
        return real(path, ...rest)
      }) as unknown as typeof fs.readFile)
      const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--json'])
      expect(outcome.code).toBe(0)
      expect(JSON.parse(outcome.stdout).data.removed).toMatchObject({
        removal: 'failed',
        reason: 'file error EBUSY',
      })
      expect(api.state.revokedKeys).toEqual([KEY_ID])
    })
  })

  it('a not_found from another organisation is not "already revoked": nothing is removed', async () => {
    await createKey()
    api.state.forced[`DELETE /partner/keys/${KEY_ID}`] = {
      status: 404,
      body: { error: { code: 'not_found', message: 'No such key.' } },
    }
    const outcome = await run(['keys', 'revoke', KEY_ID, '--yes', '--org', 'beispiel-handel'])
    expect(outcome.code).toBe(2)
    const error = errorDocOf(outcome.stderr)
    expect(error.error.code).toBe('not_found')
    expect(error.meta.hint).toContain('--org muster-it')
    expect(readFileSync(envFile(), 'utf8')).toContain('DEEPDOCK_API_KEY=')
    expect(JSON.parse(readConfigText(box)).keys).toHaveLength(1)
    expect(api.state.revokedKeys).toEqual([])
  })

  it('logout lists a key it could not revoke and keeps its entry', async () => {
    await createKey()
    api.state.forced[`DELETE /partner/keys/${KEY_ID}`] = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'Only an admin can do this.' } },
    }
    const outcome = await run(['auth', 'logout', '--json'])
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.apiKeysNotRevoked[0].error.code).toBe('forbidden')
    expect(doc.meta.hint).toContain('keys revoke')
    expect(JSON.parse(readConfigText(box)).keys).toHaveLength(1)
  })
})
