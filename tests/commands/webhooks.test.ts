import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FakeApi, startFakeApi, WEBHOOK_ID } from '../fakeApi.ts'
import { errorDocOf, execute, initRepo, makeSandbox, type Sandbox, signInWith } from '../harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  await signInWith(box, api.url)
  await execute(box, ['orgs', 'select', 'muster-it'], { baseUrl: api.url })
  initRepo(box.work, '.env*\n')
  api.requests.length = 0
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const run = (argv: string[], options: Parameters<typeof execute>[2] = {}) =>
  execute(box, argv, { baseUrl: api.url, ...options })

const URL = 'https://hooks.example.com/deepdock'
const envFile = (): string => join(box.work, '.env.local')
const requestsTo = (method: string, path: string) =>
  api.requests.filter((request) => request.method === method && request.path === path)
const webhookRequests = () => api.requests.filter((request) => request.path.includes('/webhooks'))

const createOne = async (): Promise<void> => {
  const created = await run(['webhooks', 'create', URL, '--event', 'customer.created'])
  expect(created.code).toBe(0)
  api.requests.length = 0
}

describe('webhooks create', () => {
  it('sends the event types given and writes the secret only to the env file', async () => {
    const outcome = await run([
      'webhooks',
      'create',
      URL,
      '--description',
      'orders',
      '--event',
      'customer.created',
      '--event',
      'customer.updated',
      '--write-env',
      '.env.local',
    ])
    expect(outcome.code).toBe(0)
    expect(requestsTo('POST', '/partner/webhooks')[0]?.body).toEqual({
      url: URL,
      description: 'orders',
      eventTypes: ['customer.created', 'customer.updated'],
    })
    expect(readFileSync(envFile(), 'utf8')).toBe(
      `DEEPDOCK_WEBHOOK_SECRET=${api.state.webhookSecret}\n`,
    )
    expect(statSync(envFile()).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600)
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.id).toBe(WEBHOOK_ID)
    expect(doc.meta.written).toEqual({ file: '.env.local', name: 'DEEPDOCK_WEBHOOK_SECRET' })
  })

  it('--all-events sends the types that exist now as an explicit list', async () => {
    const outcome = await run(['webhooks', 'create', URL, '--all-events'])
    expect(outcome.code).toBe(0)
    expect(requestsTo('POST', '/partner/webhooks')[0]?.body).toEqual({
      url: URL,
      eventTypes: ['customer.created', 'customer.updated'],
    })
    expect(requestsTo('GET', `/partner/webhooks/${WEBHOOK_ID}/secret`)).toHaveLength(0)
    expect(JSON.parse(outcome.stdout).meta.written).toBeUndefined()
  })

  it.each([
    [['webhooks', 'create', URL], 'at least one event type'],
    [['webhooks', 'create', URL, '--event', 'a.b', '--all-events'], 'not both'],
  ])('refuses %j before any request is made', async (argv, message) => {
    const outcome = await run(argv)
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.message).toContain(message)
    expect(webhookRequests()).toEqual([])
  })

  it('refuses --all-events when no event type exists, without creating anything', async () => {
    api.state.eventTypes = []
    const outcome = await run(['webhooks', 'create', URL, '--all-events'])
    expect(outcome.code).toBe(1)
    expect(requestsTo('POST', '/partner/webhooks')).toEqual([])
  })

  it('refuses an env file git does not ignore before the webhook exists', async () => {
    const outcome = await run([
      'webhooks',
      'create',
      URL,
      '--event',
      'a.b',
      '--write-env',
      'secrets.txt',
    ])
    expect(outcome.code).toBe(1)
    expect(requestsTo('POST', '/partner/webhooks')).toEqual([])
    expect(existsSync(join(box.work, 'secrets.txt'))).toBe(false)
  })

  it('names how to fetch the secret again when the write fails after the endpoint exists', async () => {
    api.state.webhookSecret = 'a secret with spaces'
    const outcome = await run([
      'webhooks',
      'create',
      URL,
      '--event',
      'a.b',
      '--write-env',
      '.env.local',
    ])
    expect(outcome.code).not.toBe(0)
    const doc = errorDocOf(outcome.stderr)
    expect(doc.meta.hint).toContain(`deepdock webhooks secret ${WEBHOOK_ID}`)
    expect(outcome.stdout + outcome.stderr).not.toContain('a secret with spaces')
    expect(existsSync(envFile())).toBe(false)
  })

  it('answers a member with forbidden, exit 2', async () => {
    const outcome = await run([
      'webhooks',
      'create',
      URL,
      '--event',
      'a.b',
      '--org',
      'beispiel-handel',
    ])
    expect(outcome.code).toBe(2)
    expect(errorDocOf(outcome.stderr).error.code).toBe('forbidden')
  })
})

describe('webhooks list, get and events', () => {
  it('lists and shows webhooks and the event types, as JSON and as a table', async () => {
    await createOne()
    const listed = JSON.parse((await run(['webhooks', 'list'])).stdout)
    expect(listed.data).toHaveLength(1)
    expect((await run(['webhooks', 'list'], { tty: true })).stdout).toContain(WEBHOOK_ID)
    const got = await run(['webhooks', 'get', WEBHOOK_ID], { tty: true })
    expect(got.stdout).toContain('eventTypes: customer.created')
    const events = await run(['webhooks', 'events'], { tty: true })
    expect(events.stdout).toContain('customer.updated')
  })

  it('says so when there is nothing to list', async () => {
    api.state.eventTypes = []
    expect((await run(['webhooks', 'list'], { tty: true })).stdout).toContain('No webhooks.')
    expect((await run(['webhooks', 'events'], { tty: true })).stdout).toContain('No event types')
  })

  it('refuses an id that is not a full uuid before any request is made', async () => {
    const outcome = await run(['webhooks', 'get', 'abc123'])
    expect(outcome.code).toBe(1)
    expect(webhookRequests()).toEqual([])
  })
})

describe('webhooks update, disable, enable', () => {
  beforeEach(createOne)

  it('sends only what was given and keeps an empty description', async () => {
    expect((await run(['webhooks', 'update', WEBHOOK_ID, '--description', ''])).code).toBe(0)
    expect((await run(['webhooks', 'update', WEBHOOK_ID, '--url', URL, '--all-events'])).code).toBe(
      0,
    )
    expect(requestsTo('PATCH', `/partner/webhooks/${WEBHOOK_ID}`).map((r) => r.body)).toEqual([
      { description: '' },
      { url: URL, eventTypes: ['customer.created', 'customer.updated'] },
    ])
  })

  it('refuses an update that changes nothing', async () => {
    const outcome = await run(['webhooks', 'update', WEBHOOK_ID])
    expect(outcome.code).toBe(1)
    expect(requestsTo('PATCH', `/partner/webhooks/${WEBHOOK_ID}`)).toEqual([])
  })

  it('disables and enables', async () => {
    const disabled = await run(['webhooks', 'disable', WEBHOOK_ID])
    expect(JSON.parse(disabled.stdout).data.status).toBe('disabled')
    const enabled = await run(['webhooks', 'enable', WEBHOOK_ID])
    expect(JSON.parse(enabled.stdout).data.status).toBe('active')
  })
})

describe('webhooks delete', () => {
  beforeEach(createOne)

  it('needs --yes without a terminal and deletes nothing before', async () => {
    const outcome = await run(['webhooks', 'delete', WEBHOOK_ID])
    expect(outcome.code).toBe(1)
    expect(requestsTo('DELETE', `/partner/webhooks/${WEBHOOK_ID}`)).toEqual([])
    expect((await run(['webhooks', 'delete', WEBHOOK_ID, '--yes'])).code).toBe(0)
    expect(api.state.webhooks).toEqual([])
  })
})

describe('webhooks secret and rotate-secret', () => {
  beforeEach(createOne)

  it('writes the secret to the env file and prints only its dates', async () => {
    const outcome = await run(['webhooks', 'secret', WEBHOOK_ID, '--write-env', '.env.local'])
    expect(outcome.code).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toContain(
      `DEEPDOCK_WEBHOOK_SECRET=${api.state.webhookSecret}`,
    )
    expect(JSON.parse(outcome.stdout).data).toEqual({
      id: WEBHOOK_ID,
      secretCreatedAt: '2026-11-16T10:00:00Z',
      previousSecretExpiresAt: null,
    })
  })

  it('rotates after a confirmation, then writes the new secret', async () => {
    const args = ['webhooks', 'rotate-secret', WEBHOOK_ID, '--write-env', '.env.local']
    const refused = await run(args)
    expect(refused.code).toBe(1)
    expect(requestsTo('POST', `/partner/webhooks/${WEBHOOK_ID}/secret/rotate`)).toEqual([])
    const declined = await run(args, { tty: true, stdin: 'n\n' })
    expect(declined.code).toBe(1)
    expect(existsSync(envFile())).toBe(false)
    const outcome = await run(args, { tty: true, stdin: 'y\n' })
    expect(outcome.code).toBe(0)
    expect(requestsTo('POST', `/partner/webhooks/${WEBHOOK_ID}/secret/rotate`)).toHaveLength(1)
    expect(readFileSync(envFile(), 'utf8')).toContain(api.state.webhookSecret)
  })

  it('refuses an unignored file before it rotates anything', async () => {
    const outcome = await run([
      'webhooks',
      'rotate-secret',
      WEBHOOK_ID,
      '--write-env',
      'secrets.txt',
      '--yes',
    ])
    expect(outcome.code).toBe(1)
    expect(requestsTo('POST', `/partner/webhooks/${WEBHOOK_ID}/secret/rotate`)).toEqual([])
  })
})

describe('webhooks test', () => {
  beforeEach(createOne)

  it("shows the outcome, status, duration and the receiver's answer, and exits 0", async () => {
    const outcome = await run(['webhooks', 'test', WEBHOOK_ID, '--event', 'customer.created'], {
      tty: true,
    })
    expect(outcome.code).toBe(0)
    expect(requestsTo('POST', `/partner/webhooks/${WEBHOOK_ID}/test`)[0]?.body).toEqual({
      type: 'customer.created',
    })
    expect(outcome.stdout).toContain('http error (HTTP 500, 42 ms)')
    expect(outcome.stdout).toContain('Response body: receiver says no')
    const json = JSON.parse(
      (await run(['webhooks', 'test', WEBHOOK_ID, '--event', 'customer.created'])).stdout,
    )
    expect(json.data.attempt).toMatchObject({
      outcome: 'http_error',
      statusCode: 500,
      durationMs: 42,
      responseBody: 'receiver says no',
    })
  })

  it('tells a disabled webhook how to enable it, exit 2', async () => {
    await run(['webhooks', 'disable', WEBHOOK_ID])
    const outcome = await run(['webhooks', 'test', WEBHOOK_ID, '--event', 'customer.created'])
    expect(outcome.code).toBe(2)
    const doc = errorDocOf(outcome.stderr)
    expect(doc.error.code).toBe('webhook_disabled')
    expect(doc.meta.hint).toContain(`deepdock webhooks enable ${WEBHOOK_ID}`)
  })
})
