import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractDevices } from '../../scripts/genDevices.ts'
import {
  Deepdock,
  DeepdockError,
  type Device,
  type DeviceSystem,
  type PairBody,
} from '../../skill/references/clients/deepdock.ts'
import type { paths } from './devices.openapi.generated.ts'

type Data<Response> = Response extends { content: { 'application/json': { data: infer T } } }
  ? T
  : never

// Identity, not assignability both ways: two-way assignability ignores an optional field that only
// one side has.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<_ extends true> = true

// Checked by `tsc` only: a row fails to compile when the bundled client's type and the pinned
// API's differ. Which operation each method calls is the test below.
type _ClientContract = [
  Expect<Same<Device, Data<paths['/v1/devices']['post']['responses'][201]>>>,
  Expect<Same<Device, Data<paths['/v1/devices/{deviceId}']['get']['responses'][200]>>>,
  Expect<Same<Device[], Data<paths['/v1/devices']['get']['responses'][200]>>>,
  Expect<
    Same<DeviceSystem[], Data<paths['/v1/devices/{deviceId}/systems']['get']['responses'][200]>>
  >,
  Expect<
    Same<PairBody, paths['/v1/devices']['post']['requestBody']['content']['application/json']>
  >,
]

describe('the pinned device API', () => {
  it('is already the device part, as gen:devices writes it', () => {
    const pin: unknown = JSON.parse(
      readFileSync(new URL('./devices.openapi.json', import.meta.url), 'utf8'),
    )
    expect(extractDevices(pin)).toEqual(pin)
  })

  it('has an operation for the method and path of every device call the client makes', async () => {
    const pin = JSON.parse(readFileSync(new URL('./devices.openapi.json', import.meta.url), 'utf8'))
    const calls: string[] = []
    const record = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(url)).pathname.replace('/d1', '/{deviceId}')
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      return Response.json({ data: [] })
    }
    // Bun's `typeof fetch` also wants `preconnect`, which the client never calls.
    const client = new Deepdock('ddk_test_canary', { fetch: record as typeof fetch })
    await client.pair('ABC123')
    await client.systems('d1')
    await client.release('d1')
    expect(calls).toEqual([
      'POST /v1/devices',
      'GET /v1/devices/{deviceId}/systems',
      'DELETE /v1/devices/{deviceId}',
    ])
    for (const call of calls) {
      const [method = '', path = ''] = call.split(' ')
      expect(pin.paths[path]?.[method.toLowerCase()], call).toBeDefined()
    }
  })

  it("reads blockedActions from a paired device's system", async () => {
    const answer = async (_url: string | URL | Request): Promise<Response> =>
      Response.json({
        data: { id: 'd1', systems: [{ system: 'example-erp', blockedActions: ['createNote'] }] },
      })
    const client = new Deepdock('ddk_test_canary', { fetch: answer as typeof fetch })
    const device: Device = await client.pair('ABC123')
    expect(device.systems[0]?.blockedActions).toEqual(['createNote'])
  })

  it('raises version_not_covered as a DeepdockError and does not retry it', async () => {
    let calls = 0
    const refuse = async (_url: string | URL | Request): Promise<Response> => {
      calls++
      return Response.json(
        {
          error: {
            code: 'version_not_covered',
            message: 'example-erp 2.210 is not yet approved for createNote; nothing was run',
          },
        },
        { status: 409 },
      )
    }
    const client = new Deepdock('ddk_test_canary', { fetch: refuse as typeof fetch })
    const thrown = await client.systems('d1').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(DeepdockError)
    expect(thrown).toMatchObject({ code: 'version_not_covered', status: 409 })
    expect(calls).toBe(1)
  })

  it('calls a read and a create with POST and an update with PATCH, the inputs in the JSON body and never in the URL', async () => {
    const seen: { url: string; method?: string; body: unknown; key: string | null }[] = []
    const record = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get('Idempotency-Key'),
      })
      return Response.json({ data: [], nextCursor: null })
    }
    const client = new Deepdock('ddk_test_canary', {
      base: 'https://api.example.test',
      fetch: record as typeof fetch,
    })
    await client.read(
      'd1',
      'example-erp',
      'searchCustomers',
      { lastName: 'Müller', zip: 12345 },
      {
        limit: 50,
        cursor: 'c1',
      },
    )
    await client.write('d1', 'example-erp', 'createNote', 'create', 'key-create-1', { text: 'x' })
    await client.write('d1', 'example-erp', 'updateNote', 'update', 'key-12345678', {
      noteId: 1001,
    })
    const path = 'https://api.example.test/v1/devices/d1/systems/example-erp/actions'
    expect(seen).toEqual([
      {
        url: `${path}/searchCustomers`,
        method: 'POST',
        body: { lastName: 'Müller', zip: 12345, limit: 50, cursor: 'c1' },
        key: null,
      },
      {
        url: `${path}/createNote`,
        method: 'POST',
        body: { text: 'x' },
        key: 'key-create-1',
      },
      {
        url: `${path}/updateNote`,
        method: 'PATCH',
        body: { noteId: 1001 },
        key: 'key-12345678',
      },
    ])
  })
})
