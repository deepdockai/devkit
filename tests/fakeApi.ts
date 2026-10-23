import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type RecordedRequest = {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: unknown
}

export type FakeOrg = { slug: string | null; name: string; role: string }

export type FakeState = {
  orgs: FakeOrg[]
  signInSecret: string
  signInId: string
  keyValue: string
  user: { firstName: string; email: string }
  devices: Record<string, unknown>[]
  /** Statuses answered by successive login polls; the last one repeats until collected. */
  loginPolls: string[]
  keyPolls: string[]
  /** Extra headers on every answer. */
  headers: Record<string, string>
  /** Forced answers by "METHOD /path". */
  forced: Record<string, { status: number; body: unknown }>
  cliKeys: {
    id: string
    hostname: string
    createdAt: string
    expiresAt: string
    revokedAt: string | null
  }[]
  revokedKeys: string[]
  revokedCliKeys: string[]
  keyRequestExpiresInMs: number
  /** The first `count` polls (either kind) answer this error before the scripted statuses. */
  pollFailures?: { count: number; status: number; code: string; retryAfter?: string }
  keysHandedOut: number
}

export type FakeApi = {
  url: string
  state: FakeState
  requests: RecordedRequest[]
  close: () => Promise<void>
}

export const DEVICE_ID = '450c3f0e-7a1b-4c2d-9e8f-1a2b3c4d5e6f'
export const OTHER_DEVICE_ID = '9d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'
export const KEY_ID = 'k_6a2b9c1d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'

export const defaultState = (): FakeState => ({
  orgs: [
    { slug: 'muster-it', name: 'Muster IT', role: 'admin' },
    { slug: 'beispiel-handel', name: 'Beispiel Handel GmbH', role: 'member' },
  ],
  signInId: 'cli_signin_1',
  signInSecret: ['si', 'CANARYsignin0123456789abcdef'].join('_'),
  keyValue: ['ddk', 'test', 'CANARYkey0123456789abcdefghij0123456789abcd'].join('_'),
  user: { firstName: 'Anna', email: 'anna.mueller@muster-it.example' },
  devices: [],
  loginPolls: ['approved'],
  keyPolls: ['approved'],
  headers: {},
  forced: {},
  cliKeys: [],
  revokedKeys: [],
  revokedCliKeys: [],
  keyRequestExpiresInMs: 10 * 60 * 1000,
  keysHandedOut: 0,
})

const respond = (
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const fail = (
  code: string,
  message: string,
): { error: { code: string; message: string; requestId: string } } => ({
  error: { code, message, requestId: '0b8f6a3e-7c1d-4e52-9a14-5d2c8e9f1a70' },
})

const compareVersions = (a: string, b: string): number => {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export const startFakeApi = async (overrides: Partial<FakeState> = {}): Promise<FakeApi> => {
  const state: FakeState = { ...defaultState(), ...overrides }
  const requests: RecordedRequest[] = []
  const collected = new Set<string>()
  const calls = { login: 0, key: 0, keyRequests: 0 }
  const nextStatus = (kind: 'login' | 'key'): string => {
    const list = kind === 'login' ? state.loginPolls : state.keyPolls
    const index = Math.min(calls[kind], list.length - 1)
    calls[kind] += 1
    return list[index] ?? 'pending'
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      try {
        body = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        body = raw
      }
      const path = req.url ?? '/'
      const method = req.method ?? 'GET'
      requests.push({ method, path, headers: req.headers, body })
      const send = (status: number, payload: unknown): void =>
        respond(res, status, payload, state.headers)

      const forced = state.forced[`${method} ${path}`]
      if (forced) return send(forced.status, forced.body)

      const version = String(req.headers['x-deepdock-cli'] ?? '')
      if (!version || compareVersions(version, '0.1.0') < 0) {
        return send(
          426,
          fail('client_outdated', `This CLI (${version}) is older than the API accepts.`),
        )
      }

      const isPublic = path.startsWith('/public/')
      if (!isPublic && req.headers.authorization !== `Bearer ${state.signInSecret}`) {
        return send(401, fail('unauthenticated', 'Sign in.'))
      }
      const orgSlug = String(req.headers['x-deepdock-org'] ?? '')
      const org = state.orgs.find((candidate) => candidate.slug === orgSlug)
      const needsOrg =
        path.startsWith('/partner/') &&
        path !== '/partner/orgs' &&
        !path.startsWith('/partner/cli-keys')
      if (needsOrg && !org)
        return send(403, fail('organization_required', 'Choose an organisation.'))
      const isAdmin = org?.role === 'admin'
      const record =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

      if (method === 'POST' && path === '/public/cli/logins') {
        collected.delete('login')
        calls.login = 0
        return send(201, {
          data: {
            requestId: '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6',
            approveUrl: `http://${req.headers.host}/cli?request=3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6`,
            pollSecret: 'poll-login-secret',
            expiresAt: new Date(Date.now() + state.keyRequestExpiresInMs).toISOString(),
          },
        })
      }
      const isPoll = method === 'POST' && path.endsWith('/poll')
      if (isPoll && state.pollFailures && state.pollFailures.count > 0) {
        state.pollFailures.count -= 1
        if (state.pollFailures.retryAfter)
          res.setHeader('retry-after', state.pollFailures.retryAfter)
        return send(state.pollFailures.status, fail(state.pollFailures.code, 'Slow down.'))
      }
      if (method === 'POST' && path === '/public/cli/logins/poll') {
        if (collected.has('login')) return send(404, fail('not_found', 'Unknown request.'))
        const status = nextStatus('login')
        if (status !== 'approved') return send(200, { data: { status } })
        collected.add('login')
        return send(200, {
          data: {
            status,
            id: state.signInId,
            key: state.signInSecret,
            expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
            user: state.user,
            organisations: state.orgs,
            environment: 'test',
          },
        })
      }
      if (method === 'GET' && path === '/partner/orgs') return send(200, { data: state.orgs })
      if (method === 'GET' && path === '/partner/cli-keys')
        return send(200, { data: state.cliKeys })
      const cliKeyMatch = /^\/partner\/cli-keys\/(.+)$/.exec(path)
      if (method === 'DELETE' && cliKeyMatch) {
        const id = decodeURIComponent(cliKeyMatch[1] ?? '')
        state.revokedCliKeys.push(id)
        return send(200, { data: { id, revokedAt: new Date().toISOString() } })
      }
      if (method === 'GET' && path === '/partner/systems') {
        return send(200, {
          data: [
            {
              system: 'example-erp',
              label: 'Example ERP',
              actions: [
                { name: 'searchCustomers', kind: 'read', method: 'GET' },
                { name: 'createNote', kind: 'write', method: 'POST' },
              ],
            },
          ],
        })
      }
      const openapiMatch = /^\/partner\/systems\/([^/]+)\/openapi\.json$/.exec(path)
      if (method === 'GET' && openapiMatch) {
        return send(200, {
          data: { openapi: '3.1.0', info: { title: openapiMatch[1], version: '1' } },
        })
      }
      if (method === 'GET' && path === '/partner/devices') return send(200, { data: state.devices })
      if (method === 'POST' && path === '/partner/devices') {
        if (record.code !== 'K7Q-4MX')
          return send(
            404,
            fail(
              'pairing_code_invalid',
              'The pairing code is unknown, expired, already used, or its device is offline.',
            ),
          )
        const device = {
          id: DEVICE_ID,
          label: record.label ?? null,
          status: 'connected',
          systems: [{ system: 'example-erp', version: '25.3' }],
        }
        state.devices.push(device)
        return send(201, { data: device })
      }
      const deviceMatch =
        /^\/partner\/devices\/([^/]+)(?:\/(systems)(?:\/([^/]+)\/actions)?)?$/.exec(path)
      if (deviceMatch) {
        const [, id, systems, system] = deviceMatch
        if (method === 'PATCH') return send(200, { data: { id, label: record.label } })
        if (method === 'DELETE') {
          if (!isAdmin) return send(403, fail('forbidden', 'Only an admin can do this.'))
          return send(200, { data: { id, released: true } })
        }
        if (method === 'GET' && systems && !system) {
          if (id === OTHER_DEVICE_ID)
            return send(
              503,
              fail(
                'device_offline',
                'The device is not connected or did not answer within 20 seconds.',
              ),
            )
          return send(200, {
            data: [
              {
                system: 'example-erp',
                version: '25.3',
                status: 'running',
                actions: [
                  { action: 'searchCustomers', state: 'active' },
                  {
                    action: 'createNote',
                    state: 'paused',
                    reason: 'structure_changed',
                    since: '2026-10-20T08:12:00Z',
                  },
                ],
              },
            ],
          })
        }
        if (method === 'GET' && system) {
          return send(200, {
            data: {
              actions: [
                {
                  name: 'searchCustomers',
                  method: 'GET',
                  description:
                    'Finds customers whose last name starts with lastName. Matching ignores case.\n\nRefusals:\n- invalid_input: lastName is empty',
                  input: {
                    type: 'object',
                    properties: { lastName: { type: 'string' } },
                    required: ['lastName'],
                  },
                },
                {
                  name: 'createNote',
                  method: 'POST',
                  input: {
                    type: 'object',
                    properties: { text: { type: 'string' }, orderNumber: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            },
          })
        }
      }
      if (method === 'GET' && path === '/partner/incidents') return send(200, { data: [] })
      if (method === 'GET' && path === '/partner/keys') {
        return send(200, {
          data: [
            {
              id: KEY_ID,
              name: 'myapp dev',
              keyPrefix: 'CANARYke',
              expiresAt: '2026-11-20T14:01:10Z',
            },
          ],
        })
      }
      if (method === 'POST' && path === '/partner/key-requests') {
        if (!isAdmin) return send(403, fail('forbidden', 'Only an admin can do this.'))
        if (record.name === 'taken')
          return send(409, fail('conflict', 'A key with this name exists.'))
        calls.keyRequests += 1
        const requestId = `7e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f${(0x4a00 + calls.keyRequests).toString(16)}`
        return send(201, {
          data: {
            requestId,
            approveUrl: `http://${req.headers.host}/cli?request=${requestId}`,
            pollSecret: 'poll-key-secret',
            expiresAt: new Date(Date.now() + state.keyRequestExpiresInMs).toISOString(),
            keyExpiresAt: record.expiresAt,
          },
        })
      }
      if (method === 'POST' && path === '/partner/key-requests/poll') {
        const status = nextStatus('key')
        if (status !== 'approved') return send(200, { data: { status } })
        state.keysHandedOut += 1
        return send(200, {
          data: {
            status,
            key: {
              id: KEY_ID,
              name: 'myapp dev',
              keyPrefix: state.keyValue.slice(9, 17),
              key: state.keyValue,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            },
          },
        })
      }
      const keyMatch = /^\/partner\/keys\/(.+)$/.exec(path)
      if (method === 'DELETE' && keyMatch) {
        if (!isAdmin) return send(403, fail('forbidden', 'Only an admin can do this.'))
        const id = decodeURIComponent(keyMatch[1] ?? '')
        state.revokedKeys.push(id)
        return send(200, { data: { id, revokedAt: '2026-10-21T15:20:44Z' } })
      }
      return send(404, fail('not_found', `No route ${method} ${path}.`))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
