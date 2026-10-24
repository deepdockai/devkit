import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractDevices } from '../../scripts/genDevices.ts'
import {
  Deepdock,
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
})
