import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  await signInWith(box, api.url)
  api.requests.length = 0
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const orgHeaderOf = (): string | undefined => {
  const request = api.requests.find((entry) => entry.path === '/partner/devices')
  return request?.headers['x-deepdock-org'] as string | undefined
}

describe('organisation resolution', () => {
  it('prefers --org over DEEPDOCK_ORG over the stored default', async () => {
    await execute(box, ['org', 'select', 'beispiel-handel'], { baseUrl: api.url })
    await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(orgHeaderOf()).toBe('beispiel-handel')

    api.requests.length = 0
    await execute(box, ['devices', 'list'], {
      baseUrl: api.url,
      env: { DEEPDOCK_ORG: 'muster-it' },
    })
    expect(orgHeaderOf()).toBe('muster-it')

    api.requests.length = 0
    await execute(box, ['devices', 'list', '--org', 'beispiel-handel'], {
      baseUrl: api.url,
      env: { DEEPDOCK_ORG: 'muster-it' },
    })
    expect(orgHeaderOf()).toBe('beispiel-handel')
  })

  it('fails with org_required and lists the organisations when none is chosen', async () => {
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(outcome.code).toBe(1)
    const doc = errorDocOf(outcome.stderr)
    expect(doc.error.code).toBe('org_required')
    expect(doc.meta.organisations).toEqual(['muster-it', 'beispiel-handel'])
    expect(doc.meta.hint).toContain('--org')
    expect(api.requests.some((entry) => entry.path === '/partner/devices')).toBe(false)
  })

  it('prints the human error with the organisations', async () => {
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.stderr).toContain('Error: No organisation chosen [org_required].')
    expect(outcome.stderr).toContain('Your organisations: muster-it, beispiel-handel.')
  })

  it('refuses a slug the person is not a member of with exit 1', async () => {
    const outcome = await execute(box, ['devices', 'list', '--org', 'nope'], { baseUrl: api.url })
    expect(outcome.code).toBe(1)
    const doc = errorDocOf(outcome.stderr)
    expect(doc.error.code).toBe('invalid_usage')
    expect(doc.error.message).toContain('"nope"')
  })

  it('says which organisation on stderr and in meta', async () => {
    const outcome = await execute(box, ['devices', 'list', '--org', 'muster-it'], {
      baseUrl: api.url,
    })
    expect(outcome.stderr).toContain('Organisation: Muster IT (muster-it)')
    expect(JSON.parse(outcome.stdout).meta.org).toEqual({ slug: 'muster-it', name: 'Muster IT' })
  })

  it('refreshes the stored list once before refusing a new membership', async () => {
    api.state.orgs.push({ slug: 'neu-gmbh', name: 'Neu GmbH', role: 'member' })
    const outcome = await execute(box, ['devices', 'list', '--org', 'neu-gmbh'], {
      baseUrl: api.url,
    })
    expect(outcome.code).toBe(0)
  })
})

describe('default marking and a lost default', () => {
  it('marks the organisation that commands would use: --org, then DEEPDOCK_ORG, then stored', async () => {
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
    const stored = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(stored.stdout).toMatch(/muster-it\s+Muster IT\s+admin\s+yes/)
    const env = await execute(box, ['org', 'list'], {
      baseUrl: api.url,
      tty: true,
      env: { DEEPDOCK_ORG: 'beispiel-handel' },
    })
    expect(env.stdout).toMatch(/beispiel-handel\s+Beispiel Handel GmbH\s+member\s+yes/)
    expect(env.stdout).not.toMatch(/muster-it\s+Muster IT\s+admin\s+yes/)
    const flag = await execute(box, ['org', 'list', '--org', 'beispiel-handel'], {
      baseUrl: api.url,
      tty: true,
      env: { DEEPDOCK_ORG: 'muster-it' },
    })
    expect(flag.stdout).toMatch(/beispiel-handel\s+Beispiel Handel GmbH\s+member\s+yes/)
  })

  it("hints at `org select` when the stored default is no longer one of the person's", async () => {
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
    api.state.orgs.splice(0, 1)
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url })
    expect(outcome.code).toBe(1)
    const error = errorDocOf(outcome.stderr)
    expect(error.error.message).toContain('"muster-it"')
    expect(error.meta.hint).toContain('deepdock org select')
    const flagged = await execute(box, ['devices', 'list', '--org', 'muster-it'], {
      baseUrl: api.url,
    })
    expect(errorDocOf(flagged.stderr).meta.hint).toBeUndefined()
  })
})

describe('org commands', () => {
  it('lists the organisations and marks the default', async () => {
    await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
    const outcome = await execute(box, ['org', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.stdout).toMatch(/muster-it\s+Muster IT\s+admin\s+yes/)
    expect(outcome.stdout).toMatch(/beispiel-handel\s+Beispiel Handel GmbH\s+member/)
  })

  it('org list --json passes the API data through unchanged', async () => {
    const outcome = await execute(box, ['org', 'list', '--json'], { baseUrl: api.url })
    expect(JSON.parse(outcome.stdout).data).toEqual(api.state.orgs)
  })

  it('selects by slug', async () => {
    const outcome = await execute(box, ['org', 'select', 'beispiel-handel'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(outcome.stdout).toContain(
      'Default organisation: Beispiel Handel GmbH (beispiel-handel).',
    )
    expect(JSON.parse(readConfigText(box)).defaultOrg).toBe('beispiel-handel')
  })

  it('picks from a list on a terminal', async () => {
    const outcome = await execute(box, ['org', 'select'], {
      baseUrl: api.url,
      tty: true,
      stdin: '2\n',
    })
    expect(outcome.code).toBe(0)
    expect(outcome.stderr).toContain('Which organisation should be the default?')
    expect(JSON.parse(readConfigText(box)).defaultOrg).toBe('beispiel-handel')
  })

  it('takes the first entry on an empty answer', async () => {
    await execute(box, ['org', 'select'], { baseUrl: api.url, tty: true, stdin: '\n' })
    expect(JSON.parse(readConfigText(box)).defaultOrg).toBe('muster-it')
  })

  it('without a terminal and without a slug is a usage error naming the slugs', async () => {
    const outcome = await execute(box, ['org', 'select'], { baseUrl: api.url })
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).meta.organisations).toEqual(['muster-it', 'beispiel-handel'])
  })

  it('refuses an unknown slug with exit 1', async () => {
    const outcome = await execute(box, ['org', 'select', 'nope'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toContain(
      'You are not a member of an organisation with the slug "nope" [invalid_usage].',
    )
    expect(outcome.stderr).toContain('Your organisations: muster-it, beispiel-handel.')
  })
})
