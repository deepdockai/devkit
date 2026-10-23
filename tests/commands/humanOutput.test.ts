import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_ID, type FakeApi, startFakeApi } from '../fakeApi.ts'
import { summary } from '../../src/commands/actions.ts'
import { DEFAULT_BASE_URL } from '../../src/runtime.ts'
import { makeStyler } from '../../src/output/styles.ts'
import type { Runtime } from '../../src/runtime.ts'
import { execute, makeSandbox, type Sandbox, signInWith } from '../harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  await signInWith(box, api.url)
  await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const ESCAPE = '\u001b['

describe('systems openapi', () => {
  it('prints the bare document when stdout is not a terminal', async () => {
    const outcome = await execute(box, ['systems', 'openapi', 'example-erp'], { baseUrl: api.url })
    expect(outcome.code).toBe(0)
    const document = JSON.parse(outcome.stdout)
    expect(document.openapi).toBe('3.1.0')
    expect(document.data).toBeUndefined()
    expect(document.meta).toBeUndefined()
  })

  it('keeps the envelope under an explicit --json', async () => {
    const outcome = await execute(box, ['systems', 'openapi', 'example-erp', '--json'], {
      baseUrl: api.url,
    })
    expect(JSON.parse(outcome.stdout).data.openapi).toBe('3.1.0')
  })

  it('prints the document on a terminal too', async () => {
    const outcome = await execute(box, ['systems', 'openapi', 'example-erp'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(JSON.parse(outcome.stdout).openapi).toBe('3.1.0')
  })
})

describe('devices systems on a terminal', () => {
  it('names each action beside its state', async () => {
    const outcome = await execute(box, ['devices', 'systems', DEVICE_ID], {
      baseUrl: api.url,
      tty: true,
    })
    expect(outcome.stdout).toMatch(/ACTION\s+STATE/)
    expect(outcome.stdout).toMatch(/searchCustomers\s+active/)
  })
})

describe('actions list on a terminal', () => {
  it('shows the first sentence of a description, not the whole text', async () => {
    const outcome = await execute(box, ['actions', 'list', DEVICE_ID, 'example-erp'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(outcome.stdout).toContain('Finds customers whose last name starts with lastName.')
    expect(outcome.stdout).not.toContain('Matching ignores case')
    expect(outcome.stdout).not.toContain('Refusals')
  })

  it('keeps the whole description in --json', async () => {
    const outcome = await execute(box, ['actions', 'list', DEVICE_ID, 'example-erp', '--json'], {
      baseUrl: api.url,
    })
    expect(outcome.stdout).toContain('Refusals')
  })
})

describe('auth login --wait', () => {
  it('says on stderr that it is waiting, and keeps stdout one document', async () => {
    await execute(box, ['auth', 'login'], { baseUrl: api.url })
    const outcome = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      { baseUrl: api.url },
    )
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toContain('Waiting for approval in the browser.')
    expect(() => JSON.parse(outcome.stdout)).not.toThrow()
  })
})

describe('summary', () => {
  it('keeps abbreviations, skips leading blank lines and cuts by character', () => {
    expect(summary('Lists orders, e.g. open ones. More.')).toBe('Lists orders, e.g. open ones.')
    expect(summary('\n\nFirst line here.\nSecond.')).toBe('First line here.')
    expect(summary(42)).toBeUndefined()
    const long = Array.from({ length: 200 }, () => '😀').join('')
    expect(Array.from(summary(long) ?? '')).toHaveLength(160)
  })
})

describe('colour', () => {
  it('marks states with colour and keeps the word, on a terminal only', async () => {
    const coloured = await execute(box, ['devices', 'systems', DEVICE_ID], {
      baseUrl: api.url,
      tty: true,
      colour: true,
    })
    expect(coloured.stdout).toContain(`${ESCAPE}32mactive`)
    expect(coloured.stdout).toContain(`${ESCAPE}33mpaused`)
  })

  it('writes no escape code off a terminal, under --json, or with NO_COLOR', async () => {
    const commands = [
      ['devices', 'list'],
      ['devices', 'systems', DEVICE_ID],
      ['actions', 'list', DEVICE_ID, 'example-erp'],
      ['keys', 'list'],
    ]
    for (const argv of commands) {
      const piped = await execute(box, argv, { baseUrl: api.url, colour: true })
      expect(piped.stdout + piped.stderr).not.toContain(ESCAPE)
      const json = await execute(box, [...argv, '--json'], {
        baseUrl: api.url,
        tty: true,
        colour: true,
      })
      expect(json.stdout).not.toContain(ESCAPE)
      const noColor = await execute(box, argv, {
        baseUrl: api.url,
        tty: true,
        colour: true,
        env: { NO_COLOR: '1' },
      })
      expect(noColor.stdout + noColor.stderr).not.toContain(ESCAPE)
    }
  })

  it('FORCE_COLOR colours a stream that is not a terminal, and NO_COLOR still wins', () => {
    const rt = (env: Record<string, string>): Runtime => ({ env }) as unknown as Runtime
    const pipe = { isTTY: false, write: () => undefined }
    expect(makeStyler(rt({ FORCE_COLOR: '1' }), pipe)('green', 'active')).toContain(ESCAPE)
    expect(makeStyler(rt({ FORCE_COLOR: '0' }), pipe)('green', 'active')).toBe('active')
    expect(makeStyler(rt({}), pipe)('green', 'active')).toBe('active')
    expect(makeStyler(rt({ FORCE_COLOR: '1', NO_COLOR: '1' }), pipe)('green', 'active')).toBe(
      'active',
    )
  })
})

describe('update note', () => {
  it('is yellow on a terminal and plain without colour', async () => {
    api.state.devices.push({
      id: DEVICE_ID,
      label: 'Demo PC',
      status: 'connected',
      lastSeenAt: new Date().toISOString(),
      updateAvailable: '1.8.2',
      systems: [],
    })
    const coloured = await execute(box, ['devices', 'list'], {
      baseUrl: api.url,
      tty: true,
      colour: true,
    })
    expect(coloured.stderr).toContain(`${ESCAPE}33mDemo PC: update available (client 1.8.2).`)
    const plain = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(plain.stderr).toContain('Demo PC: update available (client 1.8.2).')
    expect(plain.stderr).not.toContain(ESCAPE)
  })
})

describe('organisations, API line and systems list', () => {
  it('lists the default organisation first with the role in words and a switch hint', async () => {
    await execute(box, ['org', 'select', 'beispiel-handel'], { baseUrl: api.url })
    const outcome = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.stdout).toMatch(/NAME\s+SLUG\s+ROLE/)
    expect(outcome.stdout).toMatch(/Beispiel Handel GmbH\s+beispiel-handel\s+Member\s+default/)
    expect(outcome.stdout).toMatch(/Muster IT\s+muster-it\s+Admin\s*\n/)
    expect(outcome.stdout).not.toContain('org:')
    expect(outcome.stdout).toContain('Switch the default with `deepdock org select <slug>`.')
    const rows = outcome.stdout.split('\n').filter((line) => /muster-it|beispiel-handel/.test(line))
    expect(rows[0]).toContain('beispiel-handel')
  })

  it('shows the API line only when it is not production, and --json always has the field', async () => {
    const staging = await execute(box, ['auth', 'status'], { baseUrl: api.url, tty: true })
    expect(staging.stdout).toContain(`API: ${api.url} (not production)`)

    // A sign-in made against production, answered by the fake: the check is on the base URL alone.
    writeFileSync(
      box.configFile,
      readFileSync(box.configFile, 'utf8').replaceAll(api.url, DEFAULT_BASE_URL),
    )
    const production = await execute(box, ['auth', 'status'], {
      env: { DEEPDOCK_BASE_URL: DEFAULT_BASE_URL },
      fetch: (input, init) => fetch(input.replace(DEFAULT_BASE_URL, api.url), init),
      tty: true,
    })
    expect(production.stdout).toContain('Signed in as')
    expect(production.stdout).not.toContain('API:')
    const json = await execute(box, ['auth', 'status', '--json'], {
      env: { DEEPDOCK_BASE_URL: DEFAULT_BASE_URL },
      fetch: (input, init) => fetch(input.replace(DEFAULT_BASE_URL, api.url), init),
    })
    expect(JSON.parse(json.stdout).data.baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it('systems list shows the label and the action count', async () => {
    const outcome = await execute(box, ['systems', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.stdout).toMatch(/SYSTEM\s+NAME\s+ACTIONS/)
    expect(outcome.stdout).toMatch(/example-erp\s+\S.*\s\d+ \(\d+ read, \d+ write\)/)
  })
})
