import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_ID, type FakeApi, OTHER_DEVICE_ID, startFakeApi } from '../fakeApi.ts'
import { errorDocOf, execute, makeSandbox, type Sandbox, signInWith } from '../harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  await signInWith(box, api.url)
  await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
  api.requests.length = 0
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const run = (argv: string[], options: Parameters<typeof execute>[2] = {}) =>
  execute(box, argv, { baseUrl: api.url, ...options })

const seedDevices = (): void => {
  api.state.devices.push(
    {
      id: DEVICE_ID,
      label: 'Demo PC',
      status: 'connected',
      lastSeenAt: new Date().toISOString(),
      systems: [{ system: 'example-erp', version: '25.3' }],
      internalNote: '2026-10-01T10:00:00Z',
    },
    {
      id: OTHER_DEVICE_ID,
      label: 'Reception PC',
      status: 'offline',
      lastSeenAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      updateAvailable: '1.8.2',
      systems: [],
    },
  )
}

describe('devices list', () => {
  it('prints a table with full ids and relative times, showing only the view columns', async () => {
    seedDevices()
    const outcome = await run(['devices', 'list'], { tty: true })
    expect(outcome.stdout).toContain(DEVICE_ID)
    expect(outcome.stdout).toMatch(/Demo PC\s+connected\s+example-erp 25\.3\s+just now/)
    expect(outcome.stdout).toMatch(/Reception PC\s+offline\s+\(none reported\)\s+3 days ago/)
    expect(outcome.stdout).not.toContain('internalNote')
    expect(outcome.stdout).not.toContain('2026-10-01T10:00:00Z')
    expect(outcome.stderr).toContain('Organisation: Muster IT (muster-it)')
    expect(outcome.stderr).toContain('Reception PC: update available (client 1.8.2).')
  })

  it('passes the API data through unchanged under --json', async () => {
    seedDevices()
    const outcome = await run(['devices', 'list', '--json'])
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data).toEqual(api.state.devices)
    expect(doc.data[0].internalNote).toBe('2026-10-01T10:00:00Z')
  })

  it('says so when nothing is paired', async () => {
    const outcome = await run(['devices', 'list'], { tty: true })
    expect(outcome.stdout).toContain('No devices are paired.')
  })
})

describe('devices pair, rename, release', () => {
  it('pairs with a label', async () => {
    const outcome = await run(['devices', 'pair', 'K7Q-4MX', '--label', 'Demo PC'], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain(`Paired device ${DEVICE_ID} (Demo PC).`)
    expect(outcome.stdout).toContain('Systems:  example-erp 25.3')
    expect(api.requests.find((entry) => entry.method === 'POST')?.body).toEqual({
      code: 'K7Q-4MX',
      label: 'Demo PC',
    })
  })

  it('answers a wrong code with exit 2 and the API message', async () => {
    const outcome = await run(['devices', 'pair', 'WRONG'], { tty: true })
    expect(outcome.code).toBe(2)
    expect(outcome.stderr).toContain('[pairing_code_invalid]')
    expect(outcome.stderr).toContain('Request id: 0b8f6a3e-7c1d-4e52-9a14-5d2c8e9f1a70')
  })

  it('rejects an over-long label before any request', async () => {
    const outcome = await run(['devices', 'pair', 'K7Q-4MX', '--label', 'x'.repeat(101)])
    expect(outcome.code).toBe(1)
    expect(api.requests).toHaveLength(0)
  })

  it('renames by full id and refuses a short one', async () => {
    const renamed = await run(['devices', 'rename', DEVICE_ID, 'Front desk'], { tty: true })
    expect(renamed.stdout).toContain(`Renamed device ${DEVICE_ID} to Front desk.`)
    const short = await run(['devices', 'rename', '450c3f0e', 'x'])
    expect(short.code).toBe(1)
    expect(errorDocOf(short.stderr).error.message).toContain('not a full device id')
  })

  it('release without a terminal and without --yes stops before any request', async () => {
    const outcome = await run(['devices', 'release', DEVICE_ID])
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).meta.hint).toContain('--yes')
    expect(api.requests).toHaveLength(0)
  })

  it('release --yes deletes without asking', async () => {
    const outcome = await run(['devices', 'release', DEVICE_ID, '--yes'])
    expect(outcome.code).toBe(0)
    expect(api.requests.some((entry) => entry.method === 'DELETE')).toBe(true)
  })

  it('asks on a terminal and honours yes and no', async () => {
    seedDevices()
    const declined = await run(['devices', 'release', DEVICE_ID], { tty: true, stdin: 'n\n' })
    expect(declined.code).toBe(1)
    expect(declined.stderr).toContain(`Release device ${DEVICE_ID} (Demo PC)? [y/N]`)
    expect(api.requests.some((entry) => entry.method === 'DELETE')).toBe(false)
    const accepted = await run(['devices', 'release', DEVICE_ID], { tty: true, stdin: 'y\n' })
    expect(accepted.code).toBe(0)
    expect(accepted.stdout).toContain(`Released device ${DEVICE_ID}.`)
  })

  it('shows the API refusal for a member as exit 2', async () => {
    const outcome = await run([
      'devices',
      'release',
      DEVICE_ID,
      '--yes',
      '--org',
      'beispiel-handel',
    ])
    expect(outcome.code).toBe(2)
    expect(errorDocOf(outcome.stderr).error.code).toBe('forbidden')
  })
})

describe('devices systems and actions', () => {
  it('shows the keys the API sent and counts paused actions, exit 0', async () => {
    const outcome = await run(['devices', 'systems', DEVICE_ID], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('system: example-erp')
    expect(outcome.stdout).toContain('version: 25.3')
    expect(outcome.stdout).toMatch(/createNote\s+paused\s+structure_changed/)
    expect(outcome.stdout).toContain('One action is paused.')
    expect(outcome.stdout).toContain('503 action_paused')
  })

  it('renders a differently shaped answer from the allowed keys it has', async () => {
    api.state.forced[`GET /partner/devices/${DEVICE_ID}/systems`] = {
      status: 200,
      body: {
        data: {
          systems: [
            { name: 'billing', version: '3', state: 'running', internalNote: 'x', tags: ['a'] },
          ],
          note: 'fine',
        },
      },
    }
    const outcome = await run(['devices', 'systems', DEVICE_ID], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/NAME\s+VERSION\s+STATE/)
    expect(outcome.stdout).toMatch(/billing\s+3\s+running/)
    expect(outcome.stdout).not.toContain('internalNote')
    expect(outcome.stdout).not.toContain('tags')
    expect(outcome.stdout).not.toContain('fine')
    expect(outcome.stdout).not.toContain('paused')
  })

  it('does not fail on a scalar, an empty or an odd answer', async () => {
    for (const data of ['text', null, [], [1, 2], { a: [[1]] }]) {
      api.state.forced[`GET /partner/devices/${DEVICE_ID}/systems`] = {
        status: 200,
        body: { data },
      }
      const outcome = await run(['devices', 'systems', DEVICE_ID], { tty: true })
      expect(outcome.code).toBe(0)
    }
  })

  it('treats an offline device as exit 3', async () => {
    const outcome = await run(['devices', 'systems', OTHER_DEVICE_ID], { tty: true })
    expect(outcome.code).toBe(3)
    expect(outcome.stderr).toContain('[device_offline]')
  })

  it('lists actions with kind and fields', async () => {
    const outcome = await run(['actions', 'list', DEVICE_ID, 'example-erp'], { tty: true })
    expect(outcome.stdout).toMatch(/searchCustomers\s+read\s+lastName/)
    expect(outcome.stdout).toMatch(/createNote\s+write\s+text, orderNumber \(optional\)/)
    expect(outcome.stdout).toContain('keys create --help')
  })

  it('lists actions of another shape from the allowed keys present', async () => {
    api.state.forced[`GET /partner/devices/${DEVICE_ID}/systems/example-erp/actions`] = {
      status: 200,
      body: {
        data: [
          { name: 'Find', description: 'Looks up', cost: 3 },
          { name: 'Make', description: 'Creates' },
        ],
      },
    }
    const outcome = await run(['actions', 'list', DEVICE_ID, 'example-erp'], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/NAME\s+DESCRIPTION/)
    expect(outcome.stdout).toMatch(/Find\s+Looks up/)
    expect(outcome.stdout).not.toContain('COST')
  })

  it('lists devices without the usual id and status from the allowed keys present', async () => {
    api.state.devices.push({
      label: 'Front desk',
      os: 'windows',
      serial: 'X-1',
      owner: 'Muster IT',
    })
    const outcome = await run(['devices', 'list'], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/LABEL\s+OS/)
    expect(outcome.stdout).not.toContain('SERIAL')
    expect(outcome.stdout).not.toContain('X-1')
  })

  it('says so when an answer has none of the columns a view shows', async () => {
    api.state.devices.push({ serial: 'X-1' })
    const outcome = await run(['devices', 'list'], { tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('nothing to show in this view')
  })

  it('passes the action index through under --json', async () => {
    const outcome = await run(['actions', 'list', DEVICE_ID, 'example-erp', '--json'])
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.actions[0].input.properties.lastName.type).toBe('string')
    expect(doc.meta.org.slug).toBe('muster-it')
  })

  it('rejects a bad system name before any request', async () => {
    const outcome = await run(['actions', 'list', DEVICE_ID, '../x'])
    expect(outcome.code).toBe(1)
    expect(api.requests).toHaveLength(0)
  })
})

describe('systems, incidents, keys list', () => {
  it('prints the OpenAPI document as data', async () => {
    const outcome = await run(['systems', 'openapi', 'example-erp', '--json'])
    expect(JSON.parse(outcome.stdout).data.openapi).toBe('3.1.0')
  })

  it('lists systems, incidents and keys', async () => {
    expect((await run(['systems', 'list'], { tty: true })).stdout).toContain('example-erp')
    expect((await run(['incidents', 'list'], { tty: true })).stdout).toContain('No incidents.')
    const keys = await run(['keys', 'list'], { tty: true })
    expect(keys.stdout).toContain('myapp dev')
  })
})
