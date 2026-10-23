import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_ID, type FakeApi, startFakeApi } from '../fakeApi.ts'
import { summary } from '../../src/commands/actions.ts'
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
