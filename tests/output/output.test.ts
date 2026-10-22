import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTH_LOGIN_HELP, EXIT_CODES_HELP, KEYS_CREATE_HELP, ROOT_HELP } from '../../src/help.ts'
import { type FakeApi, startFakeApi } from '../fakeApi.ts'
import {
  errorDocOf,
  execute,
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
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const signedIn = async (): Promise<void> => {
  await signInWith(box, api.url)
  await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
  api.requests.length = 0
}

describe('json by default', () => {
  it('prints one JSON document off a terminal and a table on one', async () => {
    await signedIn()
    const piped = await execute(box, ['org', 'list'], { baseUrl: api.url })
    expect(JSON.parse(piped.stdout).data).toHaveLength(2)
    expect(piped.stdout.trim().split('\n')).toHaveLength(1)
    const terminal = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(terminal.stdout).toContain('SLUG')
    expect(() => JSON.parse(terminal.stdout)).toThrow()
  })

  it('--json forces JSON on a terminal', async () => {
    await signedIn()
    const forced = await execute(box, ['org', 'list', '--json'], { baseUrl: api.url, tty: true })
    expect(JSON.parse(forced.stdout).meta).toBeDefined()
  })

  it('accepts the global flags before or after the command', async () => {
    await signedIn()
    const before = await execute(box, ['--json', '--org', 'muster-it', 'devices', 'list'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(JSON.parse(before.stdout).meta.org.slug).toBe('muster-it')
  })

  it('keeps stdout to the document and puts context on stderr', async () => {
    await signedIn()
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(outcome.stdout.startsWith('{')).toBe(true)
    expect(outcome.stderr).toBe('Organisation: Muster IT (muster-it)\n')
  })

  it('adds the API request id to meta when the API sends one', async () => {
    await signedIn()
    api.state.headers['x-request-id'] = '5f1e2d3c-4b5a-4697-8899-aabbccddeeff'
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(JSON.parse(outcome.stdout).meta.requestId).toBe('5f1e2d3c-4b5a-4697-8899-aabbccddeeff')
  })
})

describe('usage errors', () => {
  it('reshapes an unknown flag into the JSON error form with exit 1', async () => {
    const outcome = await execute(box, ['keys', 'create', 'x', '--expire', '30d'])
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr)).toEqual({
      error: { code: 'invalid_usage', message: 'Unknown flag --expire.' },
      meta: { hint: 'Did you mean --expires? Run `deepdock keys create --help`.' },
    })
    expect(outcome.stdout).toBe('')
  })

  it('prints the human form on a terminal', async () => {
    const outcome = await execute(box, ['keys', 'create', 'x', '--expire', '30d'], { tty: true })
    expect(outcome.stderr).toBe(
      'Error: Unknown flag --expire [invalid_usage].\n  Did you mean --expires? Run `deepdock keys create --help`.\n',
    )
  })

  it('never leaks the library wording', async () => {
    for (const argv of [
      ['nope'],
      ['devices', 'pair'],
      ['devices', 'list', 'extra'],
      ['devices', 'pair', 'a', '--label'],
    ]) {
      const outcome = await execute(box, argv)
      expect(outcome.code).toBe(1)
      expect(outcome.stderr).not.toContain('error:')
      expect(errorDocOf(outcome.stderr).error.code).toBe('invalid_usage')
    }
  })

  it('treats a command group alone as a usage error naming help', async () => {
    const outcome = await execute(box, ['keys'])
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).meta.hint).toBe('Run `deepdock keys --help`.')
  })
})

describe('sign-in and version errors', () => {
  it('is sign_in_needed, exit 5, before any request when nothing is stored', async () => {
    const outcome = await execute(box, ['devices', 'list', '--org', 'muster-it'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(outcome.code).toBe(5)
    expect(outcome.stderr).toBe(
      'Error: Your sign-in is missing or expired [sign_in_needed].\n  Run `deepdock auth login`.\n',
    )
    expect(api.requests).toHaveLength(0)
  })

  it('is the same error when the API answers 401', async () => {
    await signedIn()
    api.state.signInSecret = 'revoked'
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(outcome.code).toBe(5)
    expect(errorDocOf(outcome.stderr).error.code).toBe('sign_in_needed')
  })

  it('is sign_in_needed when the stored sign-in has expired', async () => {
    await signedIn()
    const later = (): Date => new Date(Date.now() + 100 * 86400000)
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url, now: later })
    expect(outcome.code).toBe(5)
    expect(api.requests).toHaveLength(0)
  })

  it('maps client_outdated to exit 4 with the npx command', async () => {
    const outcome = await execute(box, ['auth', 'login'], {
      baseUrl: api.url,
      version: '0.0.9',
      tty: true,
    })
    expect(outcome.code).toBe(4)
    expect(outcome.stderr).toContain('[client_outdated]')
    expect(outcome.stderr).toContain('Run `npx @deepdockai/cli@latest auth login`.')
  })

  it('maps a dropped connection to connection_lost, exit 3', async () => {
    await api.close()
    const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url })
    expect(outcome.code).toBe(3)
    expect(errorDocOf(outcome.stderr).error.code).toBe('connection_lost')
    api = await startFakeApi()
  })
})

describe('terminal text from the API', () => {
  it('drops control characters from a message', async () => {
    await signedIn()
    const escapeChar = String.fromCharCode(27)
    api.state.forced['GET /partner/devices'] = {
      status: 409,
      body: { error: { code: 'conflict', message: `bad${escapeChar}[2Jnews` } },
    }
    const human = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(human.stderr).not.toContain(escapeChar)
    expect(human.stderr).toContain('bad[2Jnews')
  })

  it('prints a device refusal as quoted data', async () => {
    await signedIn()
    api.state.forced['GET /partner/devices'] = {
      status: 422,
      body: { error: { code: 'invalid_input', message: 'lastName: too long' } },
    }
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.stderr).toContain(
      'The device refused the input: "lastName: too long" [invalid_input].',
    )
  })

  it('colours only on a terminal without NO_COLOR', async () => {
    const colourful = await execute(box, ['devices', 'list'], {
      baseUrl: api.url,
      tty: true,
      colour: true,
    })
    expect(colourful.stderr).toContain('\u001b[31mError:')
    const plain = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(plain.stderr).not.toContain('\u001b[')
    const piped = await execute(box, ['devices', 'list'], { baseUrl: api.url, colour: true })
    expect(piped.stderr).not.toContain('\u001b[')
  })
})

describe('help', () => {
  it('prints the designed help texts', async () => {
    expect((await execute(box, ['--help'])).stdout).toBe(ROOT_HELP)
    expect((await execute(box, ['auth', 'login', '--help'])).stdout).toBe(AUTH_LOGIN_HELP)
    expect((await execute(box, ['keys', 'create', '--help'])).stdout).toBe(KEYS_CREATE_HELP)
    expect((await execute(box, ['help', 'exit-codes'])).stdout).toBe(EXIT_CODES_HELP)
    expect((await execute(box, ['help', 'keys', 'create'])).stdout).toBe(KEYS_CREATE_HELP)
  })

  it('derives help for the other commands from the command tree', async () => {
    const outcome = await execute(box, ['devices', 'pair', '--help'])
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('Usage\n  deepdock devices pair <code> [flags]')
    expect(outcome.stdout).toContain('--label <text>')
    expect(outcome.stdout).toContain('$ deepdock devices pair K7Q-4MX --label "Demo PC"')
  })

  it('prints the version alone', async () => {
    expect((await execute(box, ['--version'])).stdout).toBe('0.1.0\n')
    expect((await execute(box, ['-v'])).stdout).toBe('0.1.0\n')
  })

  it('prints the command tree for agents', async () => {
    const outcome = await execute(box, ['commands', '--json'])
    const tree = JSON.parse(outcome.stdout).data
    const names = tree.commands.map((command: { name: string }) => command.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'auth',
        'org',
        'systems',
        'devices',
        'actions',
        'keys',
        'incidents',
        'skill',
      ]),
    )
    expect(names).not.toContain('commands')
    const keys = tree.commands.find((command: { name: string }) => command.name === 'keys')
    const create = keys.commands.find((command: { name: string }) => command.name === 'create')
    expect(create.options.map((option: { flags: string }) => option.flags)).toContain(
      '--write-env <file>',
    )
  })
})

describe('update notice', () => {
  const setup = async (): Promise<void> => {
    await signedIn()
    api.state.headers['x-deepdock-cli-latest'] = '0.2.0'
  }

  it('prints one dim stderr line on a terminal, once a day', async () => {
    await setup()
    const first = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(first.stderr).toContain('A newer CLI is available (0.2.0): npx @deepdockai/cli@latest')
    const second = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(second.stderr).not.toContain('A newer CLI')
    const tomorrow = (): Date => new Date(Date.now() + 36 * 3600_000)
    const third = await execute(box, ['org', 'list'], {
      baseUrl: api.url,
      tty: true,
      now: tomorrow,
    })
    expect(third.stderr).toContain('A newer CLI is available')
  })

  it('never under --json, off a terminal, or in CI', async () => {
    await setup()
    for (const options of [
      { tty: true, json: true },
      { tty: false, json: false },
      { tty: true, json: false, ci: true },
    ]) {
      const argv = options.json ? ['org', 'list', '--json'] : ['org', 'list']
      const outcome = await execute(box, argv, {
        baseUrl: api.url,
        tty: options.tty,
        env: options.ci ? { CI: 'true' } : {},
      })
      expect(outcome.stderr).not.toContain('A newer CLI')
    }
    expect(readConfigText(box)).not.toContain('lastNoticeOn')
  })

  it('not when the CLI is current or after a failure', async () => {
    await setup()
    api.state.headers['x-deepdock-cli-latest'] = '0.1.0'
    expect(
      (await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })).stderr,
    ).not.toContain('A newer CLI')
    api.state.headers['x-deepdock-cli-latest'] = '0.2.0'
    api.state.forced['GET /partner/orgs'] = {
      status: 500,
      body: { error: { code: 'internal_error', message: 'x' } },
    }
    const failed = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(failed.stderr).not.toContain('A newer CLI')
  })
})
