import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractDevices } from '../../scripts/genDevices.ts'
import type { Device, DeviceSystem } from '../../skill/references/clients/deepdock.ts'
import type { paths } from './devices.openapi.generated.ts'

type Data<Response> = Response extends { content: { 'application/json': { data: infer T } } }
  ? T
  : never

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Checked by `tsc`, not at run time: a pair turns false, and fails to compile, when the bundled
// client's type and the pinned API's differ in either direction. A path or method the pin lacks
// fails at the index.
const contract: [
  Mutual<Device, Data<paths['/v1/devices']['post']['responses'][201]>>,
  Mutual<Device, Data<paths['/v1/devices/{deviceId}']['get']['responses'][200]>>,
  Mutual<Device[], Data<paths['/v1/devices']['get']['responses'][200]>>,
  Mutual<DeviceSystem[], Data<paths['/v1/devices/{deviceId}/systems']['get']['responses'][200]>>,
  Mutual<
    { code: string; label?: string },
    paths['/v1/devices']['post']['requestBody']['content']['application/json']
  >,
  paths['/v1/devices/{deviceId}']['delete'] extends object ? true : false,
] = [true, true, true, true, true, true]

describe('the pinned device API', () => {
  it('is the device part of an OpenAPI document and nothing else', () => {
    const pin: unknown = JSON.parse(
      readFileSync(new URL('./devices.openapi.json', import.meta.url), 'utf8'),
    )
    expect(extractDevices(pin)).toEqual(pin)
    expect(contract.every(Boolean)).toBe(true)
  })
})
